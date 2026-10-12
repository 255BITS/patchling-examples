/**
 * Runnable usage of filterRelevant, then generateDiff / smartapply.
 *
 *   node relevance/example.js --check
 *   node relevance/example.js --list
 *   node relevance/example.js --project shelf --task paginate-books --dry-run
 *   GPTDIFF_LLM_API_KEY=sk-nano-... node relevance/example.js --project shelf --task paginate-books
 *   node relevance/example.js --project shelf --task paginate-books --apply --out /tmp/shelf-filter.json
 *
 * --check and --dry-run do not call a model. A live run asks the cheap model
 * once per file, then (with --apply) sends only the yes files to generateDiff
 * and smartapply. Sample projects are never written.
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { filterRelevant, buildPrompt, CHEAP_MODEL } from "./filterRelevant.js";
import { loadCorpus, loadProject, validateCorpus } from "./benchmark.js";

function argValue(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1) return null;
  return args[index + 1] ?? null;
}

function has(args, flag) {
  return args.includes(flag);
}

function printHelp() {
  console.log(`Usage: node relevance/example.js [--check | --list | --project ID --task ID]

Options:
  --check            validate the hand-labeled corpus and exit
  --list             list projects and tasks
  --project ID       sample project (shelf, ink, pantry)
  --task ID          task id inside that project
  --dry-run          print the yes/no prompt for the first file and exit
  --apply            after filtering, generateDiff + smartapply on the kept files
  --model ID         cheap filter model (default ${CHEAP_MODEL})
  --diff-model ID    model for generateDiff / smartapply
  --out FILE         write { project, task, decisions } JSON a benchmark can score
  --help             show this help
`);
}

function listTasks(corpus) {
  for (const project of corpus.projects) {
    console.log(`${project.id}  ${project.name}`);
    for (const task of project.tasks) {
      console.log(`  ${task.id}`);
      console.log(`    relevant: ${task.relevant.join(", ")}`);
    }
  }
}

async function liveFilter(files, task, model) {
  let patchling;
  try {
    patchling = await import("patchling");
  } catch {
    console.error("error: npm install patchling  (needed for a live filter; --check and --dry-run do not need it)");
    process.exit(1);
  }
  const apiKey = patchling.resolveApiKey();
  if (!apiKey) {
    console.error("error: set GPTDIFF_LLM_API_KEY, or pass --dry-run to preview the prompt");
    process.exit(2);
  }
  const baseUrl = patchling.resolveBaseUrl();
  return filterRelevant(files, task, {
    model,
    callLlm: (req) => patchling.callLlm({ ...req, apiKey, baseUrl }),
    onDecision: (decision) => {
      const mark = decision.uncertain ? "keep?" : decision.relevant ? "yes" : "no";
      console.log(`${mark.padEnd(6)} ${decision.path}`);
    },
  });
}

async function applyDiff(patchling, task, relevant, diffModel, apiKey, baseUrl) {
  const kept = Object.keys(relevant);
  if (!kept.length) {
    console.log("filter kept nothing; skipping generateDiff");
    return;
  }
  console.log(`\ngenerateDiff on ${kept.length} file(s): ${kept.join(", ")}`);
  const diff = await patchling.generateDiff(patchling.buildEnvironment(relevant), task, {
    apiKey,
    baseUrl,
    model: diffModel,
  });
  console.log(diff || "(empty diff)");
  console.log("\nsmartapply on the same kept map");
  const updated = await patchling.smartapply(diff, relevant, { apiKey, baseUrl, model: diffModel });
  const changed = [];
  for (const path of new Set([...Object.keys(relevant), ...Object.keys(updated)])) {
    if (updated[path] !== relevant[path]) changed.push(path);
  }
  console.log(changed.length ? `changed: ${changed.join(", ")}` : "smartapply produced no change");
}

async function main() {
  const args = process.argv.slice(2);
  if (has(args, "--help")) {
    printHelp();
    return;
  }
  const corpus = loadCorpus();
  if (has(args, "--check")) {
    const errors = validateCorpus(corpus);
    if (errors.length) {
      for (const error of errors) console.error(`error: ${error}`);
      process.exit(1);
    }
    console.log(`corpus ok (${corpus.projects.length} projects)`);
    return;
  }
  if (has(args, "--list")) {
    listTasks(corpus);
    return;
  }

  const projectId = argValue(args, "--project");
  const taskId = argValue(args, "--task");
  if (!projectId || !taskId) {
    printHelp();
    process.exit(1);
  }
  const errors = validateCorpus(corpus);
  if (errors.length) {
    for (const error of errors) console.error(`error: ${error}`);
    process.exit(1);
  }
  const { project, files } = loadProject(projectId, corpus);
  const task = project.tasks.find((item) => item.id === taskId);
  if (!task) {
    console.error(`error: ${projectId} has no task ${taskId}`);
    process.exit(1);
  }

  const paths = Object.keys(files);
  console.log(`${project.name} / ${task.id}`);
  console.log(`${paths.length} files. Hand-labeled relevant: ${task.relevant.join(", ")}`);

  if (has(args, "--dry-run")) {
    const [first] = paths;
    console.log(`\n--- prompt for ${first} ---\n`);
    console.log(buildPrompt(first, files[first], task.task));
    console.log(`\n(dry run: ${paths.length} prompts would be sent, one per file)`);
    return;
  }

  const model = argValue(args, "--model") || CHEAP_MODEL;
  const diffModel = argValue(args, "--diff-model") || model;
  const { relevant, decisions } = await liveFilter(files, task.task, model);
  const kept = Object.keys(relevant);
  console.log(`\nkept ${kept.length} / ${paths.length}`);

  const outPath = argValue(args, "--out");
  if (outPath) {
    const payload = { project: project.id, task: task.id, decisions };
    writeFileSync(resolve(outPath), JSON.stringify(payload, null, 2) + "\n");
    console.log(`wrote ${outPath}`);
  }

  if (has(args, "--apply")) {
    const patchling = await import("patchling");
    await applyDiff(
      patchling,
      task.task,
      relevant,
      diffModel,
      patchling.resolveApiKey(),
      patchling.resolveBaseUrl(),
    );
  }
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
