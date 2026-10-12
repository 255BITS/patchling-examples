/**
 * Opt-in relevance filter for patchling (JavaScript).
 *
 * Prompt version 3. One decision per file path. The cache key is a hash of
 * the classification inputs: prompt version, model, output-token limit,
 * reasoning effort, task, file path, and content after truncation. Two paths
 * are never collapsed into one call, even when the bytes match and the cache
 * is off.
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
const WRAPPERS = /[\s"'`*“”‘’]/;

/**
 * Unicode code points divided by 4. Empty text is 0; anything else is at least 1.
 * @param {string} text
 * @returns {number}
 */
export function countTokens(text) {
  const chars = Array.from(String(text ?? ""));
  if (!chars.length) return 0;
  return Math.max(1, Math.floor(chars.length / 4));
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
 * First 8192 bytes. A NUL or a genuinely invalid UTF-8 byte is binary.
 * An incomplete trailing sequence of at most 3 bytes is not.
 * @param {Uint8Array} bytes
 * @returns {boolean}
 */
function sampleIsBinary(bytes) {
  const sample = bytes.subarray(0, BINARY_PROBE_BYTES);
  const size = sample.length;
  let index = 0;
  while (index < size) {
    const lead = sample[index];
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
      return !prefixPlausible(sample, index, have, need);
    }
    if (!sequenceValid(sample, index, need)) return true;
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
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, index));
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
 * @param {string} text
 * @returns {Promise<string>}
 */
async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Hash of the exact classification inputs. `content` is the truncated body.
 * @param {object} fields
 * @returns {Promise<string>}
 */
export async function makeCacheKey(fields) {
  const effort = fields.reasoningEffort == null ? "" : String(fields.reasoningEffort);
  const payload = [
    String(fields.promptVersion ?? FILTER_PROMPT_VERSION),
    String(fields.model ?? ""),
    String(fields.maxOutputTokens ?? DEFAULT_FILTER_MAX_OUTPUT_TOKENS),
    effort,
    String(fields.task ?? ""),
    String(fields.path ?? ""),
    String(fields.content ?? ""),
  ].join("\n");
  return sha256Hex(payload);
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
  const stripped = unwrapFence(stripThink(text)).trim();
  const line = stripped.split(/\r?\n/).map((part) => part.trim()).find(Boolean);
  if (!line) return null;
  const match = unwrapLine(line).match(/^(yes|no)(?=$|[^a-z0-9_])/i);
  if (!match) return null;
  return match[1].toLowerCase() === "yes";
}

/**
 * @param {unknown} response
 * @returns {string}
 */
function messageText(response) {
  const content = response?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (content == null) return "";
  return JSON.stringify(content);
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
        return await callLlm(payload);
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
    const text = typeof content === "string" ? content : "";
    if (isIgnoredPath(path, ignore)) {
      return decisionRow(path, { decision: "no", answer: "", skippedReason: "ignored" });
    }
    if (isBinaryContent(content)) {
      if (onBinary === "include") return decisionRow(path, { decision: "yes", answer: "", skippedReason: "binary" });
      return decisionRow(path, { decision: "no", answer: "", skippedReason: "binary" });
    }
    const body = previewBody(text, limits);
    const truncated = body !== text;
    if (truncated && onOversize === "exclude") {
      return decisionRow(path, { decision: "no", answer: "", skippedReason: "oversize" });
    }
    if (truncated && onOversize === "include") {
      return decisionRow(path, { decision: "yes", answer: "", skippedReason: "oversize" });
    }
    const key = await makeCacheKey({
      promptVersion: FILTER_PROMPT_VERSION,
      model,
      maxOutputTokens,
      reasoningEffort: reasoningEffort || "",
      task,
      path,
      content: body,
    });
    const hit = await cacheGet(key);
    if (hit) {
      const row = decisionRow(path, { decision: hit.decision, answer: hit.answer || "", cached: true });
      if (typeof opts.onDecision === "function") opts.onDecision(row);
      return row;
    }
    const prompt = buildPrompt(path, body, task, { maxBytes: null, maxTokens: null });
    const request = {
      model,
      temperature,
      maxTokens: maxOutputTokens,
      reasoningEffort: reasoningEffort || null,
      messages: [{ role: "user", content: prompt }],
    };
    let answer = "";
    try {
      const response = await ask(request);
      answer = messageText(response).trim();
    } catch (err) {
      const row = decisionRow(path, {
        failedOpen: true,
        answer: "",
        error: err?.message || String(err),
      });
      if (typeof opts.onDecision === "function") opts.onDecision(row);
      return row;
    }
    const verdict = parseYesNo(answer);
    if (verdict === null) {
      const row = decisionRow(path, { failedOpen: true, answer });
      if (typeof opts.onDecision === "function") opts.onDecision(row);
      return row;
    }
    const row = decisionRow(path, { decision: verdict ? "yes" : "no", answer });
    await cachePut(key, { decision: row.decision, answer });
    if (typeof opts.onDecision === "function") opts.onDecision(row);
    return row;
  });

  /** @type {Record<string, string | Uint8Array>} */
  const relevant = {};
  /** @type {Record<string, string | Uint8Array>} */
  const dropped = {};
  let failedOpen = 0;
  for (const decision of decisions) {
    if (decision.failedOpen) failedOpen += 1;
    const content = files[decision.path];
    if (decision.relevant) relevant[decision.path] = content;
    else dropped[decision.path] = content;
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
