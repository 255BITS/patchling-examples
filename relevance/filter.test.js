import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { REPO_ROOT, loadCorpus, validateCorpus } from "./benchmark.js";
import {
  CHEAP_MODEL,
  PROMPT_INTRO,
  buildPrompt,
  excerpt,
  filterRelevant,
  gradeDecisions,
  parseYesNo,
} from "./filterRelevant.js";

test("parseYesNo accepts a single yes or no and ignores wrappers", () => {
  assert.equal(parseYesNo("yes"), true);
  assert.equal(parseYesNo("Yes."), true);
  assert.equal(parseYesNo("YES — the route handler"), true);
  assert.equal(parseYesNo("no"), false);
  assert.equal(parseYesNo("No, this file only styles the page."), false);
  assert.equal(parseYesNo("```\nyes\n```"), true);
  assert.equal(parseYesNo("<think>maybe the tests</think>\nno"), false);
  assert.equal(parseYesNo("I think yes"), null);
  assert.equal(parseYesNo("yeah"), null);
  assert.equal(parseYesNo(""), null);
  assert.equal(parseYesNo("   \n"), null);
});

test("excerpt keeps short files and marks a truncated middle", () => {
  assert.equal(excerpt("abc", 10), "abc");
  const long = "a".repeat(50) + "MIDDLE" + "b".repeat(50);
  const cut = excerpt(long, 20);
  assert.ok(cut.includes("…[truncated]…"));
  assert.ok(cut.startsWith("a"));
  assert.ok(cut.endsWith("b"));
  assert.equal(cut.includes("MIDDLE"), false);
});

test("buildPrompt names the file and the task and states the yes/no rule", () => {
  const prompt = buildPrompt("src/routes/books.js", "export const books = 1;\n", "Add pagination.");
  assert.ok(prompt.includes(PROMPT_INTRO));
  assert.ok(prompt.includes("Reply with a single word, yes or no."));
  assert.ok(prompt.includes("Sharing a topic is not enough."));
  assert.ok(prompt.includes("File: src/routes/books.js"));
  assert.ok(prompt.includes("Add pagination."));
  assert.ok(prompt.includes("export const books = 1;"));
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
  const result = await filterRelevant(files, "Paginate the book list and update its tests.", {
    callLlm: async (req) => {
      seen.push(req);
      const path = Object.keys(answers).find((item) => req.messages[0].content.includes(`File: ${item}\n`));
      return { choices: [{ message: { content: answers[path] } }] };
    },
    onDecision: () => {},
  });
  assert.equal(seen.length, 3);
  assert.equal(seen[0].model, CHEAP_MODEL);
  assert.equal(seen[0].temperature, 0);
  assert.deepEqual(Object.keys(result.relevant), ["src/routes/books.js", "README.md"]);
  assert.deepEqual(result.dropped, { "src/routes/health.js": "health" });
  const unsure = result.decisions.find((row) => row.path === "README.md");
  assert.equal(unsure.uncertain, true);
  assert.equal(unsure.relevant, true);
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
  assert.match(dry.stdout, /File: README.md/);
  assert.match(dry.stdout, /Only the detail component needs to change/);
  assert.match(dry.stdout, /prompts would be sent/);
});
