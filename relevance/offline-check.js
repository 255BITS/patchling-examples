/**
 * Syntax and import check for the relevance examples.
 * Does not call a model and does not import patchling.
 *
 *   node relevance/offline-check.js
 */

import { readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "__pycache__" || name.startsWith(".")) continue;
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) walk(abs, acc);
    else acc.push(abs);
  }
  return acc;
}

const jsFiles = walk(HERE).filter((file) => file.endsWith(".js"));
let failed = false;
for (const file of jsFiles) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) {
    failed = true;
    console.error(`syntax ${relative(ROOT, file)}`);
    console.error(result.stderr || result.stdout);
  }
}

const pyFiles = walk(HERE).filter((file) => file.endsWith(".py"));
for (const file of pyFiles) {
  const result = spawnSync("python3", ["-m", "py_compile", file], { encoding: "utf8" });
  if (result.status !== 0) {
    failed = true;
    console.error(`syntax ${relative(ROOT, file)}`);
    console.error(result.stderr || result.stdout);
  }
}

const imported = spawnSync(
  "python3",
  ["-c", "import filter_relevant, corpus_check; print('imports ok')"],
  { cwd: HERE, encoding: "utf8" },
);
if (imported.status !== 0) {
  failed = true;
  console.error(imported.stderr || imported.stdout);
} else if (!imported.stdout.includes("imports ok")) {
  failed = true;
  console.error("python import did not report ok");
}

if (failed) process.exit(1);
console.log(`offline check ok (${jsFiles.length} js, ${pyFiles.length} py)`);
