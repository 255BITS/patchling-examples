/**
 * Opt-in relevance filter for patchling (JavaScript).
 *
 * For each file, a cheap LLM answers "is this file relevant to the task?"
 * with yes or no. Pass only `relevant` to buildEnvironment / generateDiff /
 * smartapply. Files the model does not clearly accept or reject are kept
 * (fail open) and marked uncertain, so a confused answer cannot drop a file
 * the edit needs.
 *
 * This module does not import patchling. Pass `opts.callLlm` — the same
 * function patchling exports — so the browser page and the Node example share
 * one implementation.
 */

export const CHEAP_MODEL = "xiaomi/mimo-v2.5-pro-ultraspeed";

export const PROMPT_INTRO = `You decide whether one source file is relevant to a coding task.
Reply with a single word, yes or no. Do not explain.

A file is relevant only if a correct change for the task would modify it,
or the change would be wrong without seeing the symbols this file defines.
Sharing a topic is not enough.`;

/**
 * @param {string} content
 * @param {number} limit
 * @returns {string}
 */
export function excerpt(content, limit = 6000) {
  const text = String(content ?? "");
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.7);
  const tail = limit - head;
  return text.slice(0, head) + "\n…[truncated]…\n" + text.slice(text.length - tail);
}

/**
 * @param {string} path
 * @param {string} content
 * @param {string} task
 * @param {number} [excerptChars]
 * @returns {string}
 */
export function buildPrompt(path, content, task, excerptChars = 6000) {
  return `${PROMPT_INTRO}

Task:
${task}

File: ${path}
${excerpt(content, excerptChars)}`;
}

/**
 * @param {string} text
 * @returns {boolean | null} true = yes, false = no, null = not a clear answer
 */
export function parseYesNo(text) {
  let source = String(text ?? "");
  source = source.replace(/<think>[\s\S]*?<\/think>/gi, " ");
  source = source.replace(/```[a-zA-Z0-9]*\n?/g, " ");
  source = source.replace(/```/g, " ");
  const line = source
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find(Boolean);
  if (!line) return null;
  const match = line.toLowerCase().match(/^(yes|no)\b/);
  if (!match) return null;
  return match[1] === "yes";
}

function messageText(response) {
  const content = response?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (content == null) return "";
  return JSON.stringify(content);
}

/**
 * @template T
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<any>} fn
 */
async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Math.max(1, Math.min(limit, items.length) || 1);
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

/**
 * @param {Record<string, string>} files
 * @param {string} task
 * @param {object} [opts]
 * @param {Function} opts.callLlm
 * @param {string} [opts.model]
 * @param {number} [opts.temperature]
 * @param {number | null} [opts.maxTokens]
 * @param {number} [opts.concurrency]
 * @param {number} [opts.excerptChars]
 * @param {(decision: object) => void} [opts.onDecision]
 * @returns {Promise<{ relevant: Record<string, string>, dropped: Record<string, string>, decisions: object[] }>}
 */
export async function filterRelevant(files, task, opts = {}) {
  if (typeof opts.callLlm !== "function") {
    throw new Error("filterRelevant requires opts.callLlm (patchling's callLlm, or a fake in tests).");
  }
  if (!task || !String(task).trim()) {
    throw new Error("filterRelevant requires a task string.");
  }
  const model = opts.model || CHEAP_MODEL;
  const temperature = opts.temperature ?? 0;
  const maxTokens = opts.maxTokens === undefined ? 256 : opts.maxTokens;
  const concurrency = opts.concurrency ?? 6;
  const excerptChars = opts.excerptChars ?? 6000;
  const entries = Object.entries(files);

  const decisions = await mapPool(entries, concurrency, async ([path, content]) => {
    const prompt = buildPrompt(path, content, task, excerptChars);
    const response = await opts.callLlm({
      model,
      temperature,
      maxTokens,
      messages: [{ role: "user", content: prompt }],
    });
    const answer = messageText(response).trim();
    const verdict = parseYesNo(answer);
    const decision = {
      path,
      relevant: verdict === null ? true : verdict,
      uncertain: verdict === null,
      answer,
    };
    if (typeof opts.onDecision === "function") opts.onDecision(decision);
    return decision;
  });

  /** @type {Record<string, string>} */
  const relevant = {};
  /** @type {Record<string, string>} */
  const dropped = {};
  for (const decision of decisions) {
    const content = files[decision.path];
    if (decision.relevant) relevant[decision.path] = content;
    else dropped[decision.path] = content;
  }
  return { relevant, dropped, decisions };
}

/**
 * Score filter decisions against a hand-labeled relevant-file list.
 * Paths the label names that never appear in `decisions` count as misses.
 *
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
