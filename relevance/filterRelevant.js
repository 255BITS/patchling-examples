/**
 * Opt-in relevance filter for patchling (JavaScript).
 *
 * Prompt version 3. One decision per file path. The cache key is a sha256 of
 * length-prefixed fields: prompt version, model, output-token limit, the
 * effort actually sent, task, file path, mode, preview note, and the exact
 * body sent. Two paths are never collapsed into one call. A full body and the
 * same characters produced by truncation do not share a key.
 *
 * A leading standalone yes or no (after the supported wrappers) is a decision.
 * Anything else is malformed: the file is kept, failedOpen is set, and the
 * answer is not cached. Timeouts, 5xx, and billing-reservation errors are
 * retried, then the file is kept. If the provider rejects reasoning_effort
 * with a 4xx that names it, the call is retried once without that field.
 *
 * This module does not import patchling and does not import node builtins, so
 * relevance.html can load it in the browser. Pass opts.callLlm, or use
 * postChat, which puts max_tokens and reasoning_effort on the chat body.
 */

export const FILTER_PROMPT_VERSION = 3;

/** Cheap default for the yes/no call. */
export const DEFAULT_FILTER_MODEL = "xiaomi/mimo-v2.6-flash";

/** Alias kept for the walkthrough page. */
export const CHEAP_MODEL = DEFAULT_FILTER_MODEL;

export const DEFAULT_FILTER_CONCURRENCY = 8;
export const DEFAULT_FILTER_MAX_BYTES = 200_000;
export const DEFAULT_FILTER_MAX_TOKENS = 12_000;
export const DEFAULT_FILTER_MAX_OUTPUT_TOKENS = 1024;
export const DEFAULT_FILTER_REASONING_EFFORT = "low";
export const DEFAULT_FILTER_RETRIES = 2;
export const DEFAULT_FILTER_RETRY_BASE_MS = 200;
export const BINARY_PROBE_BYTES = 8192;

/**
 * Case-insensitive globs. `**` crosses directories and `*` does not.
 * The same list is used by filter_relevant.py and documented in README.md.
 */
export const DEFAULT_IGNORE_PATTERNS = [
  "**/package-lock.json",
  "**/yarn.lock",
  "**/pnpm-lock.yaml",
  "**/bun.lock",
  "**/bun.lockb",
  "**/npm-shrinkwrap.json",
  "**/Cargo.lock",
  "**/Gemfile.lock",
  "**/poetry.lock",
  "**/Pipfile.lock",
  "**/composer.lock",
  "**/go.sum",
  "**/uv.lock",
  "**/pdm.lock",
  "**/flake.lock",
  "**/pubspec.lock",
  "**/packages.lock.json",
  "**/Package.resolved",
  "**/*.min.js",
  "**/*.min.mjs",
  "**/*.min.css",
  "**/*.map",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/coverage/**",
  "**/__pycache__/**",
  "**/*.pyc",
  "**/*.pyo",
  "**/*.generated.*",
];

export const PROMPT_INSTRUCTIONS = [
  "You are a relevance filter for a code-editing task.",
  "Decide whether the given file must be read or edited to accomplish the task, or is necessary context for that edit.",
  'Reply with a single line that starts with exactly "yes" or exactly "no", followed by a short reason.',
  'Answer "yes" when the file is likely to need changes or is required context.',
  'Answer "no" when it is unrelated. Do not write a diff.',
].join("\n");

const ANSWER_PREFIX = /^(?:answer|decision)\s*[:\-]\s*/i;
const FENCE_LINE = /^```[a-zA-Z0-9_-]*\s*$/;
const WRAPPERS = /[\s"'`*_“”‘’]/;
const LEADING_ANSWER = /^(yes|no)["'`*_“”‘’]*(?=$|\s|[.,!:;)])/iu;

/**
 * Unicode code points, rounded up. Empty text is 0. A surrogate pair is one code point.
 * @param {string} text
 * @returns {number}
 */
export function countTokens(text) {
  const chars = Array.from(String(text ?? ""));
  if (!chars.length) return 0;
  return Math.ceil(chars.length / 4);
}

/**
 * @param {number} lead
 * @returns {number} 0 when the byte cannot start a sequence
 */
function utf8SequenceLength(lead) {
  if (lead < 0x80) return 1;
  if (lead >= 0xc2 && lead <= 0xdf) return 2;
  if (lead >= 0xe0 && lead <= 0xef) return 3;
  if (lead >= 0xf0 && lead <= 0xf4) return 4;
  return 0;
}

/**
 * @param {Uint8Array} bytes
 * @param {number} index
 * @param {number} need
 * @returns {boolean}
 */
function sequenceValid(bytes, index, need) {
  const lead = bytes[index];
  for (let j = 1; j < need; j += 1) {
    if ((bytes[index + j] & 0xc0) !== 0x80) return false;
  }
  if (need === 3) {
    const next = bytes[index + 1];
    if (lead === 0xe0 && next < 0xa0) return false;
    if (lead === 0xed && next >= 0xa0) return false;
  }
  if (need === 4) {
    const next = bytes[index + 1];
    if (lead === 0xf0 && next < 0x90) return false;
    if (lead === 0xf4 && next >= 0x90) return false;
  }
  return true;
}

/**
 * @param {Uint8Array} bytes
 * @param {number} index
 * @param {number} have
 * @param {number} need
 * @returns {boolean}
 */
function prefixPlausible(bytes, index, have, need) {
  for (let j = 1; j < have; j += 1) {
    if ((bytes[index + j] & 0xc0) !== 0x80) return false;
  }
  if (have >= 2 && need >= 3) {
    const next = bytes[index + 1];
    const lead = bytes[index];
    if (lead === 0xe0 && next < 0xa0) return false;
    if (lead === 0xed && next >= 0xa0) return false;
    if (lead === 0xf0 && next < 0x90) return false;
    if (lead === 0xf4 && next >= 0x90) return false;
  }
  return true;
}

/**
 * Whole payload. A NUL or an invalid UTF-8 byte anywhere is binary.
 * An incomplete tail of at most 3 bytes is text only when the file ends
 * inside the 8192-byte probe and some valid text came first. A non-empty
 * buffer that decodes to empty text is binary.
 * @param {Uint8Array} bytes
 * @returns {boolean}
 */
function sampleIsBinary(bytes) {
  const size = bytes.length;
  let index = 0;
  while (index < size) {
    const lead = bytes[index];
    if (lead === 0) return true;
    if (lead < 0x80) {
      index += 1;
      continue;
    }
    const need = utf8SequenceLength(lead);
    if (!need) return true;
    if (index + need > size) {
      const have = size - index;
      if (have > 3) return true;
      if (!prefixPlausible(bytes, index, have, need)) return true;
      if (size > BINARY_PROBE_BYTES) return true;
      return index === 0;
    }
    if (!sequenceValid(bytes, index, need)) return true;
    index += need;
  }
  return false;
}

/**
 * @param {unknown} content
 * @returns {boolean}
 */
export function isBinaryContent(content) {
  if (content == null) return false;
  if (typeof content === "string") return sampleIsBinary(new TextEncoder().encode(content));
  if (content instanceof Uint8Array) return sampleIsBinary(content);
  return false;
}

/**
 * Cut on a code-point boundary. Never emits U+FFFD.
 * @param {string} text
 * @param {number} maxBytes
 * @returns {string}
 */
export function truncateUtf8(text, maxBytes) {
  const source = String(text ?? "");
  if (maxBytes <= 0) return "";
  const bytes = new TextEncoder().encode(source);
  if (bytes.length <= maxBytes) return source;
  let index = 0;
  while (index < maxBytes) {
    const need = utf8SequenceLength(bytes[index]);
    if (!need || index + need > maxBytes || !sequenceValid(bytes, index, need)) break;
    index += need;
  }
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, index));
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number | null}
 */
function resolveLimit(value, fallback) {
  const chosen = value === undefined ? fallback : value;
  if (chosen === null || chosen === 0) return null;
  const number = Number(chosen);
  if (!Number.isFinite(number) || number <= 0) return null;
  return number;
}

/**
 * @param {string} text
 * @param {number | null} maxBytes
 * @param {number | null} maxTokens
 * @returns {string}
 */
export function truncateText(text, maxBytes, maxTokens) {
  let out = String(text ?? "");
  if (maxTokens) {
    const chars = Array.from(out);
    const limit = maxTokens * 4;
    if (chars.length > limit) out = chars.slice(0, limit).join("");
  }
  if (maxBytes) out = truncateUtf8(out, maxBytes);
  return out;
}

/**
 * @param {string} pattern
 * @returns {RegExp}
 */
function globToRegExp(pattern) {
  let re = "";
  let index = 0;
  const src = pattern.replace(/\\/g, "/").toLowerCase();
  while (index < src.length) {
    if (src.startsWith("**/", index)) {
      re += "(?:.*/)?";
      index += 3;
      continue;
    }
    if (src.startsWith("**", index)) {
      re += ".*";
      index += 2;
      continue;
    }
    const ch = src[index];
    if (ch === "*") re += "[^/]*";
    else {
      if (/[\\^$+?.()|{}[\]]/.test(ch)) re += "\\";
      re += ch;
    }
    index += 1;
  }
  return new RegExp(`^${re}$`);
}

/**
 * @param {string} filePath
 * @param {string[]} [patterns]
 * @returns {boolean}
 */
export function isIgnoredPath(filePath, patterns = DEFAULT_IGNORE_PATTERNS) {
  const normalized = String(filePath).replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
  return patterns.some((pattern) => globToRegExp(pattern).test(normalized));
}

/**
 * @param {unknown} ignore
 * @returns {string[]}
 */
function resolveIgnore(ignore) {
  if (ignore === false || ignore === null) return [];
  if (ignore === undefined || ignore === true) return DEFAULT_IGNORE_PATTERNS;
  if (Array.isArray(ignore)) return ignore.map(String);
  throw new TypeError("ignore must be true, false, null, or an array of patterns");
}

/**
 * @param {Uint8Array | string} data
 * @returns {Promise<string>}
 */
async function sha256Hex(data) {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Classification inputs, in contract order. `content` is the exact body sent.
 * `reasoningEffort` is the effort actually sent: "low", or "" when omitted.
 * @param {object} fields
 * @returns {string[]}
 */
export function cacheKeyFields(fields) {
  const effort = fields.reasoningEffort == null || fields.reasoningEffort === ""
    ? ""
    : String(fields.reasoningEffort);
  return [
    String(fields.promptVersion ?? FILTER_PROMPT_VERSION),
    String(fields.model ?? ""),
    String(fields.maxOutputTokens ?? DEFAULT_FILTER_MAX_OUTPUT_TOKENS),
    effort,
    String(fields.task ?? fields.intent ?? ""),
    String(fields.path ?? ""),
    String(fields.mode ?? "full"),
    fields.note == null ? "" : String(fields.note),
    String(fields.content ?? ""),
  ];
}

/**
 * `<utf8 byte length>:<bytes>\n` for each field.
 * @param {string[]} parts
 * @returns {Uint8Array}
 */
export function encodeCacheKey(parts) {
  const encoder = new TextEncoder();
  const chunks = [];
  for (const part of parts) {
    const bytes = encoder.encode(String(part));
    chunks.push(encoder.encode(`${bytes.length}:`));
    chunks.push(bytes);
    chunks.push(encoder.encode("\n"));
  }
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Hash of the exact classification inputs.
 * @param {object} fields
 * @returns {Promise<string>}
 */
export async function makeCacheKey(fields) {
  return sha256Hex(encodeCacheKey(cacheKeyFields(fields)));
}

/**
 * Valid UTF-8 becomes text. A leading BOM is kept. An incomplete tail is dropped.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function decodeUtf8Bytes(bytes) {
  const decode = (chunk) => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(chunk);
  try {
    return decode(bytes);
  } catch {
    let index = 0;
    while (index < bytes.length) {
      const need = utf8SequenceLength(bytes[index]);
      if (!need || index + need > bytes.length || !sequenceValid(bytes, index, need)) break;
      index += need;
    }
    return decode(bytes.subarray(0, index));
  }
}

export class MemoryCache {
  constructor() {
    /** @type {Map<string, object>} */
    this.entries = new Map();
  }

  async get(key) {
    const record = this.entries.get(key);
    return record ? { ...record } : undefined;
  }

  async set(key, record) {
    this.entries.set(key, { ...record });
  }

  async put(key, record) {
    await this.set(key, record);
  }
}

/**
 * @param {unknown} cache
 * @returns {MemoryCache | { get: Function, set?: Function, put?: Function } | null}
 */
function resolveCache(cache) {
  if (cache === false || cache === null) return null;
  if (cache === undefined || cache === true) return new MemoryCache();
  if (typeof cache === "string") {
    throw new TypeError("pass a cache object with get and set; this example keeps the cache in memory");
  }
  if (
    cache
    && typeof cache === "object"
    && typeof cache.get === "function"
    && (typeof cache.set === "function" || typeof cache.put === "function")
  ) {
    return cache;
  }
  throw new TypeError("cache must be an object with get/set, true, false, or null");
}

/**
 * @param {string} content
 * @param {object} [limits]
 * @returns {string}
 */
function previewBody(content, limits = {}) {
  return truncateText(
    String(content ?? ""),
    resolveLimit(limits.maxBytes, DEFAULT_FILTER_MAX_BYTES),
    resolveLimit(limits.maxTokens, DEFAULT_FILTER_MAX_TOKENS),
  );
}

/**
 * Prompt the model sees. Identical text in filter_relevant.py.
 * @param {string} path
 * @param {string} content
 * @param {string} task
 * @param {object} [limits]
 * @returns {string}
 */
export function buildPrompt(path, content, task, limits) {
  const body = previewBody(content, limits || {});
  return `${PROMPT_INSTRUCTIONS}\n\nTask:\n${task}\n\nFile path:\n${path}\n\nFile contents:\n${body}`;
}

/**
 * @param {string} text
 * @returns {string}
 */
function stripThink(text) {
  return String(text ?? "")
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, " ")
    .replace(/<thinking\b[^>]*>[\s\S]*?<\/thinking>/gi, " ")
    .replace(/<think\b[^>]*>[\s\S]*$/gi, " ")
    .replace(/<thinking\b[^>]*>[\s\S]*$/gi, " ")
    .replace(/<\/think>/gi, " ")
    .replace(/<\/thinking>/gi, " ");
}

/**
 * @param {string} text
 * @returns {string}
 */
function unwrapFence(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  if (lines.length >= 2 && FENCE_LINE.test(lines[0].trim()) && lines[lines.length - 1].trim() === "```") {
    return lines.slice(1, -1).join("\n");
  }
  return text;
}

/**
 * @param {string} line
 * @returns {string}
 */
function unwrapLine(line) {
  let value = String(line ?? "").trim();
  for (let i = 0; i < 8; i += 1) {
    const next = value.replace(ANSWER_PREFIX, "").replace(new RegExp(`^${WRAPPERS.source}+`, "u"), "").replace(new RegExp(`${WRAPPERS.source}+$`, "u"), "").trim();
    if (next === value) break;
    value = next;
  }
  return value;
}

/**
 * @param {string} text
 * @returns {boolean | null} true = yes, false = no, null = malformed
 */
export function parseYesNo(text) {
  const stripped = unwrapLine(unwrapFence(stripThink(text)).trim());
  if (!stripped) return null;
  const match = stripped.match(LEADING_ANSWER);
  if (!match) return null;
  return match[1].toLowerCase() === "yes";
}

/**
 * Model text, or a throw when the envelope is not a chat completion.
 * The caller treats that throw as fail-open.
 * @param {unknown} response
 * @returns {string}
 */
export function readEnvelope(response) {
  if (typeof response === "string" || response instanceof Uint8Array) {
    throw new Error("non-JSON relevance response");
  }
  if (!response || typeof response !== "object") {
    throw new Error("non-JSON relevance response");
  }
  const choices = response.choices;
  if (!Array.isArray(choices) || choices.length === 0) throw new Error("missing choices");
  const message = choices[0] && choices[0].message;
  if (!message || typeof message !== "object") throw new Error("missing message");
  if (typeof message.content !== "string") throw new Error("missing content");
  return message.content;
}

/**
 * Wire body for a chat completion. patchling's callLlm drops reasoningEffort,
 * so the filter posts this object itself.
 * @param {object} req
 * @returns {object}
 */
export function chatRequestBody(req) {
  const body = {
    model: req.model,
    messages: req.messages,
    max_tokens: req.maxTokens,
    temperature: req.temperature ?? 0,
  };
  if (req.reasoningEffort) body.reasoning_effort = req.reasoningEffort;
  return body;
}

/**
 * @param {object} req
 * @param {{ apiKey?: string, baseUrl?: string }} [auth]
 * @returns {Promise<object>}
 */
export async function postChat(req, auth = {}) {
  const root = String(auth.baseUrl || req.baseUrl || "https://nano-gpt.com/api/v1/").replace(/\/+$/, "");
  const apiKey = auth.apiKey || req.apiKey;
  const response = await fetch(`${root}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(chatRequestBody(req)),
  });
  if (!response.ok) {
    const text = await response.text();
    const error = new Error(`LLM ${response.status}: ${text}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

/**
 * @param {unknown} err
 * @returns {number | null}
 */
function statusOf(err) {
  if (err && typeof err === "object") {
    const status = err.status ?? err.statusCode;
    if (typeof status === "number") return status;
  }
  const match = String(err?.message || err).match(/\b([45]\d\d)\b/);
  return match ? Number(match[1]) : null;
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function reasoningEffortRejected(err) {
  if (err instanceof TypeError) return false;
  const message = String(err?.message || err).toLowerCase();
  if (!message.includes("reasoning")) return false;
  const status = statusOf(err);
  if (status == null) return message.includes("400") || message.includes("unsupported") || message.includes("invalid");
  return status >= 400 && status < 500;
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isTransient(err) {
  const status = statusOf(err);
  if (status != null && status >= 500 && status <= 599) return true;
  const name = err && typeof err === "object" ? err.name : "";
  if (name === "TimeoutError" || name === "AbortError") return true;
  const message = String(err?.message || err).toLowerCase();
  if (message.includes("timeout") || message.includes("timed out")) return true;
  if (message.includes("billing reservation")) return true;
  return false;
}

/**
 * @param {string} path
 * @param {object} fields
 * @returns {object}
 */
function decisionRow(path, fields) {
  const failedOpen = !!fields.failedOpen;
  const relevant = fields.decision === "yes" || failedOpen;
  return {
    path,
    relevant,
    uncertain: failedOpen,
    failedOpen,
    failed_open: failedOpen,
    decision: relevant ? "yes" : "no",
    answer: fields.answer ?? "",
    cached: !!fields.cached,
    skippedReason: fields.skippedReason ?? null,
    skipped_reason: fields.skippedReason ?? null,
    error: fields.error ?? null,
  };
}

/**
 * @template T
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T) => Promise<any>} fn
 */
async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Math.max(1, Math.min(limit, items.length) || 1);
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

/**
 * @param {Record<string, string | Uint8Array>} files
 * @param {string} task
 * @param {object} [opts]
 */
export async function filterRelevant(files, task, opts = {}) {
  const callLlm = opts.callLlm;
  if (typeof callLlm !== "function") {
    throw new Error("filterRelevant requires opts.callLlm (postChat, or a fake in tests).");
  }
  if (!task || !String(task).trim()) {
    throw new Error("filterRelevant requires a task string.");
  }
  const model = opts.model || DEFAULT_FILTER_MODEL;
  const temperature = opts.temperature ?? 0;
  const maxOutputTokens = opts.maxOutputTokens === undefined ? DEFAULT_FILTER_MAX_OUTPUT_TOKENS : opts.maxOutputTokens;
  const reasoningEffort = opts.reasoningEffort === undefined ? DEFAULT_FILTER_REASONING_EFFORT : opts.reasoningEffort;
  const concurrency = opts.concurrency ?? DEFAULT_FILTER_CONCURRENCY;
  const retries = opts.retries === undefined ? DEFAULT_FILTER_RETRIES : opts.retries;
  const retryBaseMs = opts.retryBaseMs === undefined ? DEFAULT_FILTER_RETRY_BASE_MS : opts.retryBaseMs;
  const sleep = opts.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const log = opts.log || ((message) => console.warn(message));
  const ignore = resolveIgnore(opts.ignore);
  const onBinary = opts.onBinary || "exclude";
  const onOversize = opts.onOversize || "truncate";
  const limits = { maxBytes: opts.maxBytes, maxTokens: opts.maxTokens };
  const store = resolveCache(opts.cache);
  const entries = Object.entries(files);

  async function cacheGet(key) {
    if (!store) return undefined;
    try {
      const hit = await store.get(key);
      if (!hit || (hit.decision !== "yes" && hit.decision !== "no") || hit.failedOpen || hit.failed_open) return undefined;
      return hit;
    } catch (err) {
      log(`relevance cache read failed: ${err?.message || err}`);
      return undefined;
    }
  }

  async function cachePut(key, record) {
    if (!store) return;
    try {
      if (typeof store.set === "function") await store.set(key, record);
      else await store.put(key, record);
    } catch (err) {
      log(`relevance cache write failed: ${err?.message || err}`);
    }
  }

  async function ask(request) {
    let effort = request.reasoningEffort;
    let stripped = false;
    let attempt = 0;
    for (;;) {
      const payload = { ...request };
      if (effort) payload.reasoningEffort = effort;
      else delete payload.reasoningEffort;
      try {
        return { response: await callLlm(payload), effortSent: effort ? String(effort) : "" };
      } catch (err) {
        if (effort && !stripped && reasoningEffortRejected(err)) {
          stripped = true;
          effort = null;
          continue;
        }
        if (attempt >= retries || !isTransient(err)) throw err;
        const wait = Math.min(retryBaseMs * 2 ** attempt, 30_000);
        attempt += 1;
        if (wait > 0) await sleep(wait);
      }
    }
  }

  const decisions = await mapPool(entries, concurrency, async ([path, content]) => {
    const finish = (row) => {
      if (typeof opts.onDecision === "function") opts.onDecision(row);
      return row;
    };
    if (isIgnoredPath(path, ignore)) {
      return finish(decisionRow(path, { decision: "no", answer: "", skippedReason: "ignored" }));
    }
    if (isBinaryContent(content)) {
      const kept = onBinary === "include";
      return finish(decisionRow(path, {
        decision: kept ? "yes" : "no",
        answer: "",
        skippedReason: "binary",
      }));
    }
    const text = typeof content === "string" ? content : decodeUtf8Bytes(content);
    const body = previewBody(text, limits);
    const truncated = body !== text;
    if (truncated && onOversize === "exclude") {
      return finish(decisionRow(path, { decision: "no", answer: "", skippedReason: "oversize" }));
    }
    if (truncated && onOversize === "include") {
      return finish(decisionRow(path, { decision: "yes", answer: "", skippedReason: "oversize" }));
    }
    const mode = truncated ? "truncated" : "full";
    const note = "";
    const requestedEffort = reasoningEffort ? String(reasoningEffort) : "";
    const keyFor = (effort) => makeCacheKey({
      promptVersion: FILTER_PROMPT_VERSION,
      model,
      maxOutputTokens,
      reasoningEffort: effort,
      task,
      path,
      mode,
      note,
      content: body,
    });
    const primaryKey = await keyFor(requestedEffort);
    let hit = await cacheGet(primaryKey);
    if (!hit && requestedEffort) hit = await cacheGet(await keyFor(""));
    if (hit) {
      return finish(decisionRow(path, { decision: hit.decision, answer: hit.answer || "", cached: true }));
    }
    const prompt = buildPrompt(path, body, task, { maxBytes: null, maxTokens: null });
    const request = {
      model,
      temperature,
      maxTokens: maxOutputTokens,
      reasoningEffort: requestedEffort || null,
      messages: [{ role: "user", content: prompt }],
    };
    let answer = "";
    let effortSent = requestedEffort;
    try {
      const asked = await ask(request);
      effortSent = asked.effortSent;
      answer = readEnvelope(asked.response).trim();
    } catch (err) {
      return finish(decisionRow(path, {
        failedOpen: true,
        answer: "",
        error: err?.message || String(err),
      }));
    }
    const verdict = parseYesNo(answer);
    if (verdict === null) {
      return finish(decisionRow(path, { failedOpen: true, answer }));
    }
    const row = decisionRow(path, { decision: verdict ? "yes" : "no", answer });
    await cachePut(await keyFor(effortSent), { decision: row.decision, answer });
    return finish(row);
  });

  /** @type {Record<string, string | Uint8Array>} */
  const relevant = {};
  /** @type {Record<string, string | Uint8Array>} */
  const dropped = {};
  let failedOpen = 0;
  for (const decision of decisions) {
    if (decision.failedOpen) failedOpen += 1;
    const content = files[decision.path];
    const stored = decision.skippedReason === "binary" || typeof content === "string" || !(content instanceof Uint8Array)
      ? content
      : decodeUtf8Bytes(content);
    if (decision.relevant) relevant[decision.path] = stored;
    else dropped[decision.path] = stored;
  }
  return {
    relevant,
    dropped,
    files: relevant,
    decisions,
    failedOpen,
    failed_open: failedOpen,
    model,
  };
}

/**
 * Score filter decisions against a hand-labeled relevant-file list.
 * @param {Array<{ path: string, relevant: boolean }>} decisions
 * @param {string[]} relevantPaths
 */
export function gradeDecisions(decisions, relevantPaths) {
  const gold = new Set(relevantPaths);
  const seen = new Set();
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (const decision of decisions) {
    seen.add(decision.path);
    const expected = gold.has(decision.path);
    if (decision.relevant && expected) tp += 1;
    else if (decision.relevant && !expected) fp += 1;
    else if (!decision.relevant && expected) fn += 1;
    else tn += 1;
  }
  for (const path of gold) {
    if (!seen.has(path)) fn += 1;
  }
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  return { tp, fp, fn, tn, precision, recall };
}
