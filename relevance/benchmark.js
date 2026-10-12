/**
 * Validate the hand-labeled relevance corpus, and score a filter run against it.
 *
 *   node relevance/benchmark.js
 *   node relevance/benchmark.js --score relevance/last-run.json
 *
 * A project file is relevant when a correct edit has to modify it, or would be
 * wrong without the symbols that file defines. Topic neighbors are left out.
 * Benchmark scripts should treat `tasks[].relevant` as the positive class and
 * every other file under the project root as the negative class.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gradeDecisions } from "./filterRelevant.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = dirname(HERE);
export const CORPUS_PATH = join(HERE, "corpus.json");

const SKIP_DIRS = new Set(["node_modules", "__pycache__", ".git"]);

/**
 * @param {string} dir
 * @param {string} [prefix]
 * @returns {string[]} posix relative paths
 */
export function walkProject(dir, prefix = "") {
  /** @type {string[]} */
  const files = [];
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith(".")) continue;
    if (SKIP_DIRS.has(name)) continue;
    const abs = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    const info = statSync(abs);
    if (info.isDirectory()) files.push(...walkProject(abs, rel));
    else if (info.isFile()) files.push(rel);
  }
  return files;
}

/**
 * @param {unknown} corpus
 * @param {(root: string) => string[]} [listFiles]
 * @returns {string[]} human-readable errors, empty when the corpus is usable
 */
export function validateCorpus(corpus, listFiles = (root) => walkProject(root)) {
  /** @type {string[]} */
  const errors = [];
  if (!corpus || typeof corpus !== "object" || !Array.isArray(corpus.projects)) {
    return ["corpus must be an object with a projects array"];
  }
  const projectIds = new Set();
  for (const project of corpus.projects) {
    const id = project && project.id;
    if (!id || typeof id !== "string") {
      errors.push("project is missing a string id");
      continue;
    }
    if (projectIds.has(id)) errors.push(`${id}: duplicate project id`);
    projectIds.add(id);
    if (!project.root || typeof project.root !== "string") {
      errors.push(`${id}: missing root`);
      continue;
    }
    const abs = resolve(REPO_ROOT, project.root);
    let onDisk;
    try {
      onDisk = listFiles(abs);
    } catch (err) {
      errors.push(`${id}: cannot read ${project.root} (${err.message})`);
      continue;
    }
    if (!Array.isArray(project.files) || project.files.length === 0) {
      errors.push(`${id}: files must be a non-empty array of relative paths`);
    } else {
      const listed = [...project.files];
      const sorted = [...listed].sort();
      if (listed.some((path, index) => path !== sorted[index])) {
        errors.push(`${id}: files must be sorted`);
      }
      const diskSet = new Set(onDisk);
      const listedSet = new Set(listed);
      for (const path of listed) {
        if (!diskSet.has(path)) errors.push(`${id}: listed file is not on disk: ${path}`);
      }
      for (const path of onDisk) {
        if (!listedSet.has(path)) errors.push(`${id}: on-disk file missing from corpus files: ${path}`);
      }
      if (listed.length !== listedSet.size) errors.push(`${id}: duplicate paths in files`);
    }
    if (!Array.isArray(project.tasks) || project.tasks.length < 2) {
      errors.push(`${id}: expected several tasks`);
      continue;
    }
    const taskIds = new Set();
    const fileSet = new Set(project.files || []);
    for (const task of project.tasks) {
      if (!task || typeof task.id !== "string" || !task.id) {
        errors.push(`${id}: task is missing an id`);
        continue;
      }
      if (taskIds.has(task.id)) errors.push(`${id}: duplicate task id ${task.id}`);
      taskIds.add(task.id);
      if (typeof task.task !== "string" || task.task.trim().length < 20) {
        errors.push(`${id}/${task.id}: task text is missing or too short`);
      }
      if (!Array.isArray(task.relevant) || task.relevant.length === 0) {
        errors.push(`${id}/${task.id}: relevant must be a non-empty array`);
        continue;
      }
      const relSet = new Set(task.relevant);
      if (relSet.size !== task.relevant.length) {
        errors.push(`${id}/${task.id}: duplicate relevant paths`);
      }
      for (const path of task.relevant) {
        if (!fileSet.has(path)) errors.push(`${id}/${task.id}: relevant path is not in the project: ${path}`);
      }
      if (fileSet.size > 0 && relSet.size >= fileSet.size) {
        errors.push(`${id}/${task.id}: relevant lists every file, so the filter has nothing to drop`);
      }
    }
  }
  return errors;
}

export function loadCorpus(path = CORPUS_PATH) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * @param {string} projectId
 * @param {object} [corpus]
 * @returns {{ project: object, files: Record<string, string> }}
 */
export function loadProject(projectId, corpus = loadCorpus()) {
  const project = corpus.projects.find((item) => item.id === projectId);
  if (!project) throw new Error(`unknown project ${projectId}`);
  const root = resolve(REPO_ROOT, project.root);
  /** @type {Record<string, string>} */
  const files = {};
  for (const rel of project.files) {
    files[rel] = readFileSync(join(root, rel), "utf8");
  }
  return { project, files };
}

/**
 * @param {object} run  { project, task, decisions } or an array of those
 * @param {object} [corpus]
 */
export function scoreRun(run, corpus = loadCorpus()) {
  const rows = Array.isArray(run) ? run : [run];
  return rows.map((row) => {
    const project = corpus.projects.find((item) => item.id === row.project);
    if (!project) throw new Error(`unknown project ${row.project}`);
    const task = project.tasks.find((item) => item.id === row.task);
    if (!task) throw new Error(`unknown task ${row.project}/${row.task}`);
    const grade = gradeDecisions(row.decisions || [], task.relevant);
    return { project: project.id, task: task.id, ...grade };
  });
}

function printGrades(grades) {
  for (const grade of grades) {
    const precision = (grade.precision * 100).toFixed(1);
    const recall = (grade.recall * 100).toFixed(1);
    console.log(
      `${grade.project}/${grade.task}  precision ${precision}%  recall ${recall}%  tp ${grade.tp} fp ${grade.fp} fn ${grade.fn} tn ${grade.tn}`,
    );
  }
}

function main() {
  const args = process.argv.slice(2);
  const scoreFlag = args.indexOf("--score");
  const corpus = loadCorpus();
  const errors = validateCorpus(corpus);
  if (errors.length) {
    for (const error of errors) console.error(`error: ${error}`);
    process.exit(1);
  }
  const files = corpus.projects.reduce((sum, project) => sum + project.files.length, 0);
  const tasks = corpus.projects.reduce((sum, project) => sum + project.tasks.length, 0);
  console.log(`corpus ok: ${corpus.projects.length} projects, ${tasks} tasks, ${files} files`);
  for (const project of corpus.projects) {
    console.log(`  ${project.id}  ${project.files.length} files  ${project.tasks.length} tasks  (${project.name})`);
  }
  if (scoreFlag !== -1) {
    const scorePath = args[scoreFlag + 1];
    if (!scorePath) {
      console.error("error: --score needs a JSON file from example.js --out");
      process.exit(1);
    }
    const grades = scoreRun(JSON.parse(readFileSync(resolve(scorePath), "utf8")), corpus);
    printGrades(grades);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
