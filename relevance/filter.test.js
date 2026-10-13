import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  decodeUtf8Bytes,
  filterRelevant,
  gradeDecisions,
  isBinaryContent,
  isIgnoredPath,
  encodeCacheKey,
  makeCacheKey,
  MemoryCache,
  parseYesNo,
  truncateText,
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
  assert.equal(parseYesNo("yes?"), null);
  assert.equal(parseYesNo("__yes__"), true);
  assert.equal(parseYesNo("“no”"), false);
  assert.equal(parseYesNo(" no, this file is irrelevant \nyes, the function to rename is here"), false);
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
  assert.equal(countTokens("abcde"), 2);
  assert.equal(countTokens("😀😀😀😀"), 1);
  assert.equal(truncateText("abc😀def", null, 1), "abc😀");
  assert.equal(truncateText("中文测试额外", null, 1), "中文测试");
  assert.equal(truncateText("cafe\u0301XYZ", null, 1), "cafe");
  assert.equal(truncateText("abc😀def", null, 1).includes("\uFFFD"), false);
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

test("a full abc and a body truncated to abc do not share a cache key", async () => {
  const shared = {
    model: "m",
    task: "edit",
    path: "a.py",
    content: "abc",
    maxOutputTokens: 1024,
    reasoningEffort: "low",
    promptVersion: 3,
    note: "",
  };
  const full = await makeCacheKey({ ...shared, mode: "full" });
  const cut = await makeCacheKey({ ...shared, mode: "truncated" });
  assert.notEqual(full, cut);
  assert.equal(new TextDecoder().decode(encodeCacheKey(["ab"])), "2:ab\n");
  assert.notEqual(
    new TextDecoder().decode(encodeCacheKey(["a", "b"])),
    new TextDecoder().decode(encodeCacheKey(["ab"])),
  );
});

test("changed bytes at the same path are classified again", async () => {
  const calls = [];
  const cache = new MemoryCache();
  const callLlm = async (req) => {
    calls.push(req.messages[0].content);
    return { choices: [{ message: { content: "yes" } }] };
  };
  const task = "Edit the target module only.";
  const opts = { cache, log: () => {}, callLlm };
  const first = await filterRelevant({ "src/target.py": new TextEncoder().encode("alpha = 1\n") }, task, opts);
  const second = await filterRelevant({ "src/target.py": new TextEncoder().encode("beta = 2\n") }, task, opts);
  assert.equal(calls.length, 2);
  assert.match(calls[0], /alpha = 1/);
  assert.match(calls[1], /beta = 2/);
  assert.equal(first.decisions[0].cached, false);
  assert.equal(second.decisions[0].cached, false);
  assert.equal(first.relevant["src/target.py"], "alpha = 1\n");
  assert.equal(second.relevant["src/target.py"], "beta = 2\n");
  assert.equal(decodeUtf8Bytes(new TextEncoder().encode("alpha = 1\n")), "alpha = 1\n");
  const third = await filterRelevant({ "src/target.py": new TextEncoder().encode("beta = 2\n") }, task, opts);
  assert.equal(calls.length, 2);
  assert.equal(third.decisions[0].cached, true);
  const bad = await filterRelevant({ "a.bin": new Uint8Array([0x61, 0xff]) }, task, {
    cache: false,
    log: () => {},
    callLlm,
  });
  assert.equal(calls.length, 2);
  assert.equal(bad.decisions[0].skippedReason, "binary");
  assert.equal(bad.decisions[0].skipped_reason, "binary");
  assert.equal(bad.relevant["a.bin"], undefined);
});

test("a broken model envelope fails open and is not cached", async () => {
  const cache = new MemoryCache();
  const bad = [
    null,
    "not-json",
    {},
    { choices: [] },
    { choices: [{}] },
    { choices: [{ message: {} }] },
    { choices: [{ message: { content: null } }] },
    { choices: [{ message: { content: "" } }] },
  ];
  let calls = 0;
  const callLlm = async () => {
    calls += 1;
    return bad[Math.min(calls, bad.length) - 1];
  };
  const first = await filterRelevant({ "a.js": "x" }, TASK, { cache, log: () => {}, callLlm });
  const second = await filterRelevant({ "a.js": "x" }, TASK, { cache, log: () => {}, callLlm });
  assert.equal(calls, 2);
  assert.equal(first.failedOpen, 1);
  assert.equal(second.failedOpen, 1);
  assert.equal(first.relevant["a.js"], "x");
  assert.equal(first.decisions[0].cached, false);
  for (const response of bad) {
    const result = await filterRelevant({ "a.js": "x" }, TASK, {
      cache: false,
      log: () => {},
      callLlm: async () => response,
    });
    assert.equal(result.failedOpen, 1, JSON.stringify(response));
    assert.equal(result.relevant["a.js"], "x");
  }
});

test("a rejected reasoning effort is stored under the empty effort key", async () => {
  const cache = new MemoryCache();
  let calls = 0;
  const callLlm = async (req) => {
    calls += 1;
    if (req.reasoningEffort) {
      const error = new Error("LLM 400: unsupported parameter reasoning_effort");
      error.status = 400;
      throw error;
    }
    return { choices: [{ message: { content: "no" } }] };
  };
  const opts = { cache, log: () => {}, retryBaseMs: 0, sleep: async () => {}, callLlm };
  const first = await filterRelevant({ "a.js": "x" }, TASK, opts);
  assert.equal(calls, 2);
  assert.equal(first.dropped["a.js"], "x");
  const second = await filterRelevant({ "a.js": "x" }, TASK, opts);
  assert.equal(calls, 2);
  assert.equal(second.decisions[0].cached, true);
  assert.equal(second.dropped["a.js"], "x");
});

test("a TypeError is not treated as a rejected reasoning effort", async () => {
  let calls = 0;
  const result = await filterRelevant({ "a.js": "x" }, TASK, {
    cache: false,
    log: () => {},
    callLlm: async () => {
      calls += 1;
      throw new TypeError("unsupported");
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.failedOpen, 1);
  assert.equal(result.relevant["a.js"], "x");
});

test("a truncated UTF-8 tail keeps the valid prefix", async () => {
  const bytes = Uint8Array.from([0x61, 0xc3]);
  assert.equal(isBinaryContent(bytes), false);
  assert.equal(decodeUtf8Bytes(bytes), "a");
  assert.equal(decodeUtf8Bytes(bytes).includes("\uFFFD"), false);
  let body = "";
  const result = await filterRelevant({ "a.py": bytes }, TASK, {
    cache: false,
    log: () => {},
    callLlm: async (req) => {
      body = req.messages[0].content;
      return { choices: [{ message: { content: "yes" } }] };
    },
  });
  assert.equal(result.decisions[0].skippedReason, null);
  assert.equal(result.files["a.py"], "a");
  assert.equal(result.relevant["a.py"], "a");
  assert.equal(body.endsWith("File contents:\na"), true);
  assert.equal(body.includes("\uFFFD"), false);
});

test("an ignored binary file is excluded before any UTF-8 decode", async () => {
  const Original = globalThis.TextDecoder;
  let decodes = 0;
  globalThis.TextDecoder = class SpyDecoder extends Original {
    decode(...args) {
      decodes += 1;
      return super.decode(...args);
    }
  };
  try {
    const bytes = Uint8Array.from([0x61, 0xc3, 0xff, 0x00]);
    const result = await filterRelevant(
      { "dist/app.min.js": bytes, "src/keep.js": "export const n = 1;\n" },
      TASK,
      {
        cache: false,
        log: () => {},
        callLlm: async () => ({ choices: [{ message: { content: "yes" } }] }),
      },
    );
    const ignored = result.decisions.find((decision) => decision.path === "dist/app.min.js");
    assert.equal(ignored.decision, "no");
    assert.equal(ignored.skippedReason, "ignored");
    assert.equal(Object.hasOwn(result.files, "dist/app.min.js"), false);
    assert.equal(result.dropped["dist/app.min.js"], bytes);
    assert.equal(decodes, 0);
    assert.equal(result.files["src/keep.js"], "export const n = 1;\n");
  } finally {
    globalThis.TextDecoder = Original;
  }
});

test("invalid UTF-8 after the 8192-byte probe is binary and keeps original bytes", async () => {
  const payload = new Uint8Array(8192 + 1 + 4);
  payload.fill(0x61, 0, 8192);
  payload[8192] = 0xff;
  payload.set([0x54, 0x41, 0x49, 0x4c], 8193);
  assert.equal(isBinaryContent(payload), true);
  let calls = 0;
  const callLlm = async () => {
    calls += 1;
    return { choices: [{ message: { content: "yes" } }] };
  };
  const excluded = await filterRelevant({ "a.bin": payload }, TASK, { cache: false, log: () => {}, callLlm });
  assert.equal(calls, 0);
  assert.equal(excluded.decisions[0].skippedReason, "binary");
  assert.equal(excluded.relevant["a.bin"], undefined);
  assert.equal(excluded.dropped["a.bin"], payload);
  assert.equal(excluded.dropped["a.bin"][8192], 0xff);
  assert.equal(new TextDecoder().decode(excluded.dropped["a.bin"].subarray(8193)), "TAIL");

  const included = await filterRelevant({ "a.bin": payload }, TASK, {
    cache: false,
    log: () => {},
    onBinary: "include",
    callLlm,
  });
  assert.equal(calls, 0);
  assert.equal(included.relevant["a.bin"], payload);
  assert.equal(included.decisions[0].relevant, true);
  assert.equal(included.relevant["a.bin"][8192], 0xff);
});

test("a non-string message content fails open and is not cached", async () => {
  const cache = new MemoryCache();
  let calls = 0;
  const callLlm = async () => {
    calls += 1;
    return { choices: [{ message: { content: ["no"] } }] };
  };
  const opts = { cache, log: () => {}, callLlm };
  const first = await filterRelevant({ "a.js": "x" }, TASK, opts);
  const second = await filterRelevant({ "a.js": "x" }, TASK, opts);
  assert.equal(calls, 2);
  assert.equal(first.failedOpen, 1);
  assert.equal(second.failedOpen, 1);
  assert.equal(first.decisions[0].cached, false);
  assert.equal(second.decisions[0].cached, false);
  assert.equal(first.relevant["a.js"], "x");
  assert.notEqual(first.decisions[0].answer, "no");
});

test("a quoted no followed by a reason is no", () => {
  assert.equal(parseYesNo("**no** unrelated"), false);
  assert.equal(parseYesNo('"no" unrelated'), false);
  assert.equal(parseYesNo("“no” — unrelated"), false);
  assert.equal(parseYesNo("yes?"), null);
  assert.equal(parseYesNo("nope"), null);
  assert.equal(parseYesNo("no**unrelated"), null);
  assert.equal(parseYesNo("YES — the route handler"), true);
  assert.equal(parseYesNo("No,"), false);
});

test("a leading UTF-8 BOM is preserved in decoded text and cache keys", async () => {
  const bom = new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x62, 0x63]);
  const text = decodeUtf8Bytes(bom);
  assert.equal(text, "\uFEFFabc");
  assert.equal(text.codePointAt(0), 0xfeff);
  assert.equal(truncateUtf8(text, 3), "\uFEFF");
  assert.equal(countTokens("\uFEFFabcd"), 2);
  assert.equal(truncateText(text, null, 1), "\uFEFFabc");
  const key = await makeCacheKey({
    model: "m",
    task: "edit",
    path: "a.js",
    content: text,
    maxOutputTokens: 1024,
    reasoningEffort: "low",
    promptVersion: 3,
    mode: "full",
    note: "",
  });
  const py = spawnSync("python3", ["-c", `
import sys
sys.path.insert(0, "relevance")
from filter_relevant import decode_utf8_bytes, make_cache_key, truncate_utf8
text = decode_utf8_bytes(bytes([0xEF, 0xBB, 0xBF, 0x61, 0x62, 0x63]))
assert text == "\\ufeffabc", text
assert truncate_utf8(text, 3) == "\\ufeff"
print(make_cache_key(model="m", task="edit", path="a.js", content=text, max_output_tokens=1024, reasoning_effort="low", prompt_version=3, mode="full", note=""))
`], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(py.status, 0, py.stderr);
  assert.equal(py.stdout.trim(), key);
  let seen = "";
  const result = await filterRelevant({ "a.js": bom }, TASK, {
    cache: false,
    log: () => {},
    callLlm: async (req) => {
      seen = req.messages[0].content;
      return { choices: [{ message: { content: "yes" } }] };
    },
  });
  assert.equal(result.relevant["a.js"], "\uFEFFabc");
  assert.ok(seen.includes("\uFEFFabc"));
});

test("an ordinary yes is requested exactly once", async () => {
  let calls = 0;
  const result = await filterRelevant({ "a.js": "x" }, TASK, {
    cache: false,
    log: () => {},
    callLlm: async () => {
      calls += 1;
      return { choices: [{ message: { content: "yes" } }] };
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.failedOpen, 0);
  assert.equal(result.decisions[0].skippedReason, null);
});

test("minified modules are ignored", async () => {
  let calls = 0;
  const result = await filterRelevant({ "src/app.min.mjs": "bundle", "src/app.js": "source" }, TASK, {
    cache: false,
    log: () => {},
    callLlm: async (req) => {
      calls += 1;
      assert.match(req.messages[0].content, /File path:\nsrc\/app\.js\n/);
      return { choices: [{ message: { content: "yes" } }] };
    },
  });
  assert.equal(calls, 1);
  const skipped = result.decisions.find((row) => row.path === "src/app.min.mjs");
  assert.equal(skipped.skippedReason, "ignored");
  assert.equal(skipped.skipped_reason, "ignored");
  assert.equal(skipped.relevant, false);
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
    truncate_text,
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
    "tokens5": count_tokens("abcde"),
    "emojiCut": truncate_text("abc😀def", None, 1),
    "cjk": truncate_text("中文测试额外", None, 1),
    "mark": truncate_text("cafe\\u0301XYZ", None, 1),
    "mjs": is_ignored_path("src/app.min.mjs"),
    "fullKey": make_cache_key(model="m", task="edit", path="a.py", content="abc", max_output_tokens=1024, reasoning_effort="low", prompt_version=3, mode="full", note=""),
    "cutKey": make_cache_key(model="m", task="edit", path="a.py", content="abc", max_output_tokens=1024, reasoning_effort="low", prompt_version=3, mode="truncated", note=""),
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
  assert.equal(got.tokens5, 2);
  assert.equal(got.emojiCut, "abc😀");
  assert.equal(got.cjk, "中文测试");
  assert.equal(got.mark, "cafe");
  assert.equal(got.mjs, true);
  assert.notEqual(got.fullKey, got.cutKey);
  assert.equal(got.fullKey, await makeCacheKey({
    model: "m", task: "edit", path: "a.py", content: "abc", maxOutputTokens: 1024, reasoningEffort: "low", promptVersion: 3, mode: "full", note: "",
  }));
  assert.equal(got.version, 3);
  assert.deepEqual(got.patterns, DEFAULT_IGNORE_PATTERNS);
});

const FIXTURE_PATH = join(REPO_ROOT, "relevance/fixtures/parity/relevance.json");
const FIXTURE_SHA256 = "c5f3bd4af43ff2a2036b8012c2ed69c70cd9b2c09281bc58e864fb0194eebe5c";

test("parity fixture matches the canonical sha256 and this filter", async () => {
  const raw = readFileSync(FIXTURE_PATH);
  assert.equal(createHash("sha256").update(raw).digest("hex"), FIXTURE_SHA256);
  const fixture = JSON.parse(raw.toString("utf8"));
  assert.equal(FILTER_PROMPT_VERSION, fixture.promptVersion);
  assert.equal(DEFAULT_FILTER_MAX_OUTPUT_TOKENS, fixture.maxOutputTokens);
  assert.equal(DEFAULT_FILTER_REASONING_EFFORT, fixture.reasoningEffort);
  assert.equal(fixture.tokenEstimate.rule, "ceil(code_points/4)");
  assert.equal(countTokens(""), fixture.tokenEstimate.empty);
  for (const example of fixture.tokenEstimate.examples) {
    assert.equal(countTokens(example.text), example.tokens, JSON.stringify(example.text));
  }
  for (const row of fixture.tokenTruncation) {
    const got = truncateText(row.text, null, row.maxTokens);
    assert.equal(got, row.expected, row.text);
    assert.equal(got.includes("\uFFFD"), false);
  }
  for (const row of fixture.truncation) {
    const got = truncateUtf8(row.text, row.maxBytes);
    assert.equal(got, row.expected, row.text);
    assert.equal(got.includes("\uFFFD"), false);
  }
  for (const row of fixture.parser) {
    const parsed = parseYesNo(row.raw);
    const decision = parsed === true ? "yes" : parsed === false ? "no" : null;
    assert.equal(decision, row.decision, JSON.stringify(row.raw));
  }
  assert.equal(fixture.malformedIsFailedOpen, true);
  assert.equal(fixture.ignore.label, "ignored");
  assert.deepEqual([...DEFAULT_IGNORE_PATTERNS], fixture.ignore.patterns);
  for (const example of fixture.ignore.examples) {
    assert.equal(isIgnoredPath(example.path), example.ignored, example.path);
  }
  for (const row of fixture.binary.cases) {
    const bytes = new Uint8Array(row.pad + row.tail.length);
    bytes.fill(0x61, 0, row.pad);
    bytes.set(row.tail, row.pad);
    assert.equal(isBinaryContent(bytes), row.binary, row.name);
    if (row.text != null) assert.equal(decodeUtf8Bytes(bytes), row.text, row.name);
  }
  const bomBytes = Uint8Array.from(fixture.bom.bytes);
  assert.equal(decodeUtf8Bytes(bomBytes), fixture.bom.text);
  assert.equal(isBinaryContent(bomBytes), false);
  assert.equal(countTokens(fixture.bom.text), fixture.bom.tokens);
  assert.equal(truncateText(fixture.bom.text, null, fixture.bom.maxTokens), fixture.bom.truncated);
  assert.deepEqual(fixture.cacheKey.fields, [
    "prompt_version",
    "model",
    "max_output_tokens",
    "effort_sent",
    "task",
    "path",
    "mode",
    "note",
    "content",
  ]);
  for (const vector of fixture.cacheKey.vectors) {
    const encoded = encodeCacheKey([
      String(vector.prompt_version),
      String(vector.model),
      String(vector.max_output_tokens),
      vector.effort_sent == null ? "" : String(vector.effort_sent),
      String(vector.task),
      String(vector.path),
      String(vector.mode),
      vector.note == null ? "" : String(vector.note),
      String(vector.content),
    ]);
    assert.equal(createHash("sha256").update(encoded).digest("hex"), vector.sha256, vector.mode);
    const key = await makeCacheKey({
      promptVersion: vector.prompt_version,
      model: vector.model,
      maxOutputTokens: vector.max_output_tokens,
      reasoningEffort: vector.effort_sent,
      task: vector.task,
      path: vector.path,
      mode: vector.mode,
      note: vector.note,
      content: vector.content,
    });
    assert.equal(key, vector.sha256, `${vector.path} ${vector.mode}`);
  }
  const full = fixture.cacheKey.vectors.find((vector) => vector.mode === "full" && vector.content === "abc");
  const truncated = fixture.cacheKey.vectors.find((vector) => vector.mode === "truncated" && vector.content === "abc");
  assert.notEqual(full.sha256, truncated.sha256);

  const yes = () => ({ choices: [{ message: { content: "yes" } }] });
  for (const row of fixture.tokenTruncation) {
    let body = null;
    await filterRelevant({ "a.py": row.text }, "task", {
      cache: false,
      maxBytes: null,
      maxTokens: row.maxTokens,
      log: () => {},
      callLlm: async (req) => {
        body = req.messages[0].content.split("File contents:\n")[1];
        return yes();
      },
    });
    assert.equal(body, row.expected, row.text);
  }
  for (const row of fixture.truncation) {
    let body = null;
    await filterRelevant({ "a.py": row.text }, "task", {
      cache: false,
      maxBytes: row.maxBytes,
      maxTokens: null,
      log: () => {},
      callLlm: async (req) => {
        body = req.messages[0].content.split("File contents:\n")[1];
        return yes();
      },
    });
    assert.equal(body, row.expected, row.text);
  }

  const seen = [];
  let calls = 0;
  const cache = new MemoryCache();
  const callLlm = async (req) => {
    calls += 1;
    seen.push(req.messages[0].content);
    return yes();
  };
  const opts = { cache, log: () => {}, callLlm, maxBytes: null, maxTokens: null };
  const encoded = new TextEncoder().encode(fixture.bytes.validUtf8);
  const first = await filterRelevant({ "a.py": encoded }, "task", opts);
  assert.equal(first.files["a.py"], fixture.bytes.validUtf8);
  assert.equal(first.relevant["a.py"], fixture.bytes.validUtf8);
  assert.notEqual(first.files["a.py"], "");
  assert.equal(first.decisions[0].skippedReason, null);
  assert.match(seen[0], new RegExp(fixture.bytes.validUtf8));
  const [left, right] = fixture.bytes.changed;
  await filterRelevant({ "a.py": new TextEncoder().encode(left) }, "task", opts);
  await filterRelevant({ "a.py": new TextEncoder().encode(right) }, "task", opts);
  assert.equal(calls, 3);
  const invalid = await filterRelevant({ "a.py": Uint8Array.from([0xff]) }, "task", opts);
  assert.equal(invalid.decisions[0].skippedReason, "binary");
  assert.equal(invalid.decisions[0].skipped_reason, "binary");
  assert.equal(invalid.decisions[0].decision, "no");
  assert.equal(calls, 3);
  const bomFile = await filterRelevant({ "a.py": Uint8Array.from(fixture.bom.bytes) }, "task", {
    cache: false,
    log: () => {},
    maxBytes: null,
    maxTokens: null,
    callLlm: async (req) => {
      assert.ok(req.messages[0].content.includes(fixture.bom.text));
      return yes();
    },
  });
  assert.equal(bomFile.relevant["a.py"], fixture.bom.text);

  let ignoredCalls = 0;
  const ignored = await filterRelevant(
    { "src/app.min.mjs": "var a=1;\n", "src/app.js": "export const a = 1;\n" },
    "task",
    {
      cache: false,
      log: () => {},
      callLlm: async () => {
        ignoredCalls += 1;
        return yes();
      },
    },
  );
  const skipped = ignored.decisions.find((row) => row.path === "src/app.min.mjs");
  assert.equal(skipped.decision, "no");
  assert.equal(skipped.skippedReason, fixture.ignore.label);
  assert.equal(skipped.skipped_reason, fixture.ignore.label);
  assert.equal(ignoredCalls, 1);

  let malformedCalls = 0;
  const malformedCache = new MemoryCache();
  const openFirst = await filterRelevant({ "src/target.py": "x = 1\n" }, "edit the target", {
    cache: malformedCache,
    log: () => {},
    callLlm: async () => {
      malformedCalls += 1;
      return { choices: [{ message: { content: "There is no doubt this file is required" } }] };
    },
  });
  const openSecond = await filterRelevant({ "src/target.py": "x = 1\n" }, "edit the target", {
    cache: malformedCache,
    log: () => {},
    callLlm: async () => {
      malformedCalls += 1;
      return { choices: [{ message: { content: "There is no doubt this file is required" } }] };
    },
  });
  assert.equal(malformedCalls, 2);
  assert.equal(openFirst.decisions[0].decision, "yes");
  assert.equal(openFirst.decisions[0].failedOpen, true);
  assert.equal(openFirst.failedOpen, 1);
  assert.equal(openSecond.decisions[0].cached, false);
});

test("offline check is syntax and imports only", () => {
  const check = spawnSync(process.execPath, ["relevance/offline-check.js"], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr + check.stdout);
  assert.match(check.stdout, /offline check ok/);
});
