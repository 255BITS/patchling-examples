import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { REPO_ROOT, loadCorpus, validateCorpus } from "./benchmark.js";
import {
  CHEAP_MODEL,
  DEFAULT_FILTER_MAX_OUTPUT_TOKENS,
  DEFAULT_FILTER_REASONING_EFFORT,
  DEFAULT_IGNORE_PATTERNS,
  FILTER_PROMPT_VERSION,
  PROMPT_INSTRUCTIONS,
  buildPrompt,
  chatRequestBody,
  countTokens,
  filterRelevant,
  gradeDecisions,
  isBinaryContent,
  isIgnoredPath,
  makeCacheKey,
  MemoryCache,
  parseYesNo,
  truncateUtf8,
} from "./filterRelevant.js";

const TASK = "Paginate the book list and update its tests.";

test("parseYesNo accepts a leading yes or no after the supported wrappers", () => {
  assert.equal(parseYesNo("yes"), true);
  assert.equal(parseYesNo("Yes."), true);
  assert.equal(parseYesNo("YES — the route handler"), true);
  assert.equal(parseYesNo('"yes"'), true);
  assert.equal(parseYesNo("**no**"), false);
  assert.equal(parseYesNo("Answer: yes"), true);
  assert.equal(parseYesNo("Decision: no"), false);
  assert.equal(parseYesNo("no"), false);
  assert.equal(parseYesNo("No, this file only styles the page."), false);
  assert.equal(parseYesNo("```\nyes\n```"), true);
  assert.equal(parseYesNo("<think>maybe the tests</think>\nno"), false);
  assert.equal(parseYesNo("\nno"), false);
  assert.equal(parseYesNo("I think yes"), null);
  assert.equal(parseYesNo("yeah"), null);
  assert.equal(parseYesNo("nope"), null);
  assert.equal(parseYesNo("There is no doubt this file is required"), null);
  assert.equal(parseYesNo(""), null);
  assert.equal(parseYesNo("   \n"), null);
});

test("truncation stays on a code-point boundary and never emits U+FFFD", () => {
  assert.equal(truncateUtf8("éX", 2), "é");
  assert.equal(truncateUtf8("€X", 3), "€");
  assert.equal(truncateUtf8("€X", 2), "");
  assert.equal(truncateUtf8("😀X", 4), "😀");
  assert.equal(truncateUtf8("😀X", 3), "");
  for (const value of [truncateUtf8("éX", 2), truncateUtf8("€X", 3), truncateUtf8("😀X", 4)]) {
    assert.equal(value.includes("\uFFFD"), false);
  }
  assert.equal(countTokens(""), 0);
  assert.equal(countTokens("abcd"), 1);
  assert.equal(countTokens("😀😀😀😀"), 1);
});

test("binary detection tolerates only an incomplete trailing sequence", () => {
  const cut = new Uint8Array(8192);
  cut.fill(0x61);
  cut[8191] = 0xc3;
  assert.equal(isBinaryContent(cut), false);
  const longer = new Uint8Array(8193);
  longer.fill(0x61, 0, 8191);
  longer[8191] = 0xc3;
  longer[8192] = 0xa9;
  assert.equal(isBinaryContent(longer), false);
  assert.equal(isBinaryContent(new Uint8Array([0x61, 0x00, 0x62])), true);
  assert.equal(isBinaryContent(new Uint8Array([0x61, 0xff, 0x62])), true);
  assert.equal(isBinaryContent("plain text"), false);
});

test("ignore patterns match the canonical list", () => {
  assert.equal(isIgnoredPath("src/routes/books.js"), false);
  assert.equal(isIgnoredPath("dist/app.min.js"), true);
  assert.equal(isIgnoredPath("Package.resolved"), true);
  assert.equal(isIgnoredPath("src/pkg.min.css"), true);
  assert.equal(DEFAULT_IGNORE_PATTERNS.includes("**/npm-shrinkwrap.json"), true);
});

test("buildPrompt names the path on its own line and states the yes/no rule", () => {
  const prompt = buildPrompt("src/routes/books.js", "export const books = 1;\n", "Add pagination.");
  assert.ok(prompt.startsWith(PROMPT_INSTRUCTIONS));
  assert.equal(FILTER_PROMPT_VERSION, 3);
  assert.ok(prompt.includes('starts with exactly "yes" or exactly "no"'));
  assert.ok(prompt.includes("File path:\nsrc/routes/books.js\n"));
  assert.ok(prompt.includes("Add pagination."));
  assert.ok(prompt.includes("export const books = 1;"));
  const twinA = buildPrompt("src/lib/note.js", "same", TASK);
  const twinB = buildPrompt("src/notes/note.js", "same", TASK);
  assert.notEqual(twinA, twinB);
});

test("chat body carries 1024 tokens and reasoning_effort low", () => {
  const body = chatRequestBody({
    model: CHEAP_MODEL,
    messages: [{ role: "user", content: "hi" }],
    maxTokens: DEFAULT_FILTER_MAX_OUTPUT_TOKENS,
    temperature: 0,
    reasoningEffort: DEFAULT_FILTER_REASONING_EFFORT,
  });
  assert.equal(body.max_tokens, 1024);
  assert.equal(body.reasoning_effort, "low");
  assert.equal(body.temperature, 0);
});

test("filterRelevant keeps yes files, drops no files, and fails open", async () => {
  const files = {
    "src/routes/books.js": "books",
    "src/routes/health.js": "health",
    "README.md": "readme",
  };
  const answers = {
    "src/routes/books.js": "yes",
    "src/routes/health.js": "no",
    "README.md": "perhaps",
  };
  const seen = [];
  const result = await filterRelevant(files, TASK, {
    cache: false,
    log: () => {},
    callLlm: async (req) => {
      seen.push(req);
      const path = Object.keys(answers).find((item) => req.messages[0].content.includes(`File path:\n${item}\n`));
      return { choices: [{ message: { content: answers[path] } }] };
    },
  });
  assert.equal(seen.length, 3);
  assert.equal(seen[0].model, CHEAP_MODEL);
  assert.equal(seen[0].temperature, 0);
  assert.equal(seen[0].maxTokens, 1024);
  assert.equal(seen[0].reasoningEffort, "low");
  assert.deepEqual(Object.keys(result.relevant), ["src/routes/books.js", "README.md"]);
  assert.deepEqual(result.files, result.relevant);
  assert.deepEqual(result.dropped, { "src/routes/health.js": "health" });
  const unsure = result.decisions.find((row) => row.path === "README.md");
  assert.equal(unsure.uncertain, true);
  assert.equal(unsure.failedOpen, true);
  assert.equal(unsure.relevant, true);
  assert.equal(result.failedOpen, 1);
});

test("same content at two paths is two decisions, and a no is not reused", async () => {
  const files = { "unrelated.py": "", "src/target.py": "" };
  const calls = [];
  const cache = new MemoryCache();
  const callLlm = async (req) => {
    calls.push(req.messages[0].content);
    if (req.messages[0].content.includes("File path:\nunrelated.py\n")) {
      return { choices: [{ message: { content: "no" } }] };
    }
    if (req.messages[0].content.includes("File path:\nsrc/target.py\n")) {
      return { choices: [{ message: { content: "yes" } }] };
    }
    throw new Error("unexpected prompt");
  };
  const first = await filterRelevant(files, "Edit the target module only.", {
    cache,
    log: () => {},
    callLlm,
  });
  assert.equal(calls.length, 2);
  assert.equal(first.relevant["src/target.py"], "");
  assert.equal(first.dropped["unrelated.py"], "");
  assert.equal("src/target.py" in first.dropped, false);

  const again = await filterRelevant({ "src/target.py": "" }, "Edit the target module only.", {
    cache,
    log: () => {},
    callLlm,
  });
  assert.equal(calls.length, 2);
  assert.equal(again.relevant["src/target.py"], "");
  assert.equal(again.decisions[0].cached, true);

  calls.length = 0;
  const uncached = await filterRelevant(files, "Edit the target module only.", {
    cache: false,
    log: () => {},
    callLlm,
  });
  assert.equal(calls.length, 2);
  assert.equal(uncached.relevant["src/target.py"], "");
  assert.equal(uncached.dropped["unrelated.py"], "");
});

test("a malformed answer is kept and is not cached", async () => {
  const cache = new MemoryCache();
  let calls = 0;
  const callLlm = async () => {
    calls += 1;
    return { choices: [{ message: { content: "There is no doubt this file is required" } }] };
  };
  const opts = { cache, log: () => {}, callLlm };
  const first = await filterRelevant({ "a.js": "x" }, TASK, opts);
  const second = await filterRelevant({ "a.js": "x" }, TASK, opts);
  assert.equal(calls, 2);
  assert.equal(first.failedOpen, 1);
  assert.equal(second.failedOpen, 1);
  assert.equal(first.relevant["a.js"], "x");
  assert.equal(first.decisions[0].cached, false);
});

test("a 4xx that names reasoning_effort is retried once without it", async () => {
  const seen = [];
  const result = await filterRelevant({ "a.js": "x" }, TASK, {
    cache: false,
    retryBaseMs: 0,
    sleep: async () => {},
    log: () => {},
    callLlm: async (req) => {
      seen.push(req.reasoningEffort || null);
      if (req.reasoningEffort) {
        const error = new Error("LLM 400: unsupported parameter reasoning_effort");
        error.status = 400;
        throw error;
      }
      return { choices: [{ message: { content: "no" } }] };
    },
  });
  assert.deepEqual(seen, ["low", null]);
  assert.equal(result.dropped["a.js"], "x");
  assert.equal(result.failedOpen, 0);
});

test("timeouts and billing errors retry, then fail open", async () => {
  let calls = 0;
  const result = await filterRelevant({ "a.js": "x" }, TASK, {
    cache: false,
    retries: 2,
    retryBaseMs: 0,
    sleep: async () => {},
    log: () => {},
    callLlm: async () => {
      calls += 1;
      const error = new Error("LLM 503: billing reservation");
      error.status = 503;
      throw error;
    },
  });
  assert.equal(calls, 3);
  assert.equal(result.failedOpen, 1);
  assert.equal(result.decisions[0].relevant, true);
  assert.equal(result.decisions[0].uncertain, true);
  assert.equal(result.relevant["a.js"], "x");
});

test("cache read and write failures are logged and do not abort the run", async () => {
  const logs = [];
  const broken = {
    async get() {
      throw new Error("unreadable");
    },
    async set() {
      throw new Error("disk full");
    },
  };
  let calls = 0;
  const result = await filterRelevant({ "a.js": "x" }, TASK, {
    cache: broken,
    log: (message) => logs.push(message),
    callLlm: async () => {
      calls += 1;
      return { choices: [{ message: { content: "no" } }] };
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.dropped["a.js"], "x");
  assert.equal(result.failedOpen, 0);
  assert.ok(logs.some((message) => message.includes("read failed")));
  assert.ok(logs.some((message) => message.includes("write failed")));
});

test("gradeDecisions counts misses the model never returned", () => {
  const grade = gradeDecisions(
    [
      { path: "a.js", relevant: true },
      { path: "b.js", relevant: false },
      { path: "c.js", relevant: true },
    ],
    ["a.js", "b.js", "d.js"],
  );
  assert.equal(grade.tp, 1);
  assert.equal(grade.fn, 2);
  assert.equal(grade.fp, 1);
  assert.equal(grade.tn, 0);
  assert.equal(grade.recall, 1 / 3);
});

test("the hand-labeled corpus matches the sample projects", () => {
  const errors = validateCorpus(loadCorpus());
  assert.deepEqual(errors, []);
});

test("the shelf twin files are byte-identical and only one path is relevant", () => {
  const corpus = loadCorpus();
  const shelf = corpus.projects.find((project) => project.id === "shelf");
  const task = shelf.tasks.find((item) => item.id === "path-not-content");
  const left = readFileSync(join(REPO_ROOT, "relevance/projects/shelf/src/lib/note.js"));
  const right = readFileSync(join(REPO_ROOT, "relevance/projects/shelf/src/notes/note.js"));
  assert.deepEqual(left, right);
  assert.deepEqual(task.relevant, ["src/notes/note.js"]);
  assert.equal(task.relevant.includes("src/lib/note.js"), false);
});

test("example.js --check and --dry-run run without an API key", () => {
  const check = spawnSync(process.execPath, ["relevance/example.js", "--check"], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /corpus ok/);

  const dry = spawnSync(
    process.execPath,
    ["relevance/example.js", "--project", "pantry", "--task", "detail-meta", "--dry-run"],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /File path:\nREADME.md/);
  assert.match(dry.stdout, /Only the detail component needs to change/);
  assert.match(dry.stdout, /prompts would be sent/);
});

test("python agrees on the prompt, cache key, truncation, and ignore list", async () => {
  const prompt = buildPrompt("src/notes/note.js", "same\n", "Wire the receipt note.");
  const key = await makeCacheKey({
    model: CHEAP_MODEL,
    task: "Wire the receipt note.",
    path: "src/notes/note.js",
    content: "same\n",
    maxOutputTokens: 1024,
    reasoningEffort: "low",
    promptVersion: 3,
  });
  const other = await makeCacheKey({
    model: CHEAP_MODEL,
    task: "Wire the receipt note.",
    path: "src/lib/note.js",
    content: "same\n",
    maxOutputTokens: 1024,
    reasoningEffort: "low",
    promptVersion: 3,
  });
  assert.notEqual(key, other);
  const script = `
import json, sys
sys.path.insert(0, "relevance")
from filter_relevant import (
    FILTER_PROMPT_VERSION,
    DEFAULT_IGNORE_PATTERNS,
    build_prompt,
    make_cache_key,
    truncate_utf8,
    is_ignored_path,
    count_tokens,
)
print(json.dumps({
    "prompt": build_prompt("src/notes/note.js", "same\\n", "Wire the receipt note."),
    "key": make_cache_key(model="${CHEAP_MODEL}", task="Wire the receipt note.", path="src/notes/note.js", content="same\\n", max_output_tokens=1024, reasoning_effort="low", prompt_version=3),
    "cut": truncate_utf8("éX", 2),
    "euro3": truncate_utf8("€X", 3),
    "euro2": truncate_utf8("€X", 2),
    "emoji4": truncate_utf8("😀X", 4),
    "emoji3": truncate_utf8("😀X", 3),
    "ignored": is_ignored_path("dist/app.min.js"),
    "kept": is_ignored_path("src/app.js"),
    "case": is_ignored_path("Package.resolved"),
    "tokens": count_tokens("😀😀😀😀"),
    "version": FILTER_PROMPT_VERSION,
    "patterns": list(DEFAULT_IGNORE_PATTERNS),
}))
`;
  const py = spawnSync("python3", ["-c", script], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(py.status, 0, py.stderr);
  const got = JSON.parse(py.stdout);
  assert.equal(got.prompt, prompt);
  assert.equal(got.key, key);
  assert.equal(got.cut, "é");
  assert.equal(got.cut.includes("\uFFFD"), false);
  assert.equal(got.euro3, "€");
  assert.equal(got.euro2, "");
  assert.equal(got.emoji4, "😀");
  assert.equal(got.emoji3, "");
  assert.equal(got.ignored, true);
  assert.equal(got.kept, false);
  assert.equal(got.case, true);
  assert.equal(got.tokens, 1);
  assert.equal(got.version, 3);
  assert.deepEqual(got.patterns, DEFAULT_IGNORE_PATTERNS);
});

test("offline check is syntax and imports only", () => {
  const check = spawnSync(process.execPath, ["relevance/offline-check.js"], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr + check.stdout);
  assert.match(check.stdout, /offline check ok/);
});
