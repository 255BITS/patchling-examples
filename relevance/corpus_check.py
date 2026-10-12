"""Load and validate relevance/corpus.json. No third-party imports.

Benchmark scripts can import ``validate_corpus`` or shell out to
``python relevance/example.py --check``.
"""

from __future__ import annotations

import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent
CORPUS_PATH = HERE / "corpus.json"
SKIP_DIRS = {"node_modules", "__pycache__", ".git"}


def walk_project(root: Path) -> list[str]:
    files: list[str] = []
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        rel_parts = path.relative_to(root).parts
        if any(part.startswith(".") or part in SKIP_DIRS for part in rel_parts):
            continue
        files.append("/".join(rel_parts))
    return files


def load_corpus(path: Path | None = None) -> dict:
    return json.loads((path or CORPUS_PATH).read_text(encoding="utf-8"))


def validate_corpus(corpus: dict, list_files=walk_project) -> list[str]:
    errors: list[str] = []
    projects = corpus.get("projects") if isinstance(corpus, dict) else None
    if not isinstance(projects, list):
        return ["corpus must be an object with a projects array"]
    seen_projects: set[str] = set()
    for project in projects:
        project_id = project.get("id") if isinstance(project, dict) else None
        if not isinstance(project_id, str) or not project_id:
            errors.append("project is missing a string id")
            continue
        if project_id in seen_projects:
            errors.append(f"{project_id}: duplicate project id")
        seen_projects.add(project_id)
        root = project.get("root")
        if not isinstance(root, str) or not root:
            errors.append(f"{project_id}: missing root")
            continue
        abs_root = (REPO_ROOT / root).resolve()
        try:
            on_disk = list_files(abs_root)
        except OSError as err:
            errors.append(f"{project_id}: cannot read {root} ({err})")
            continue
        listed = project.get("files")
        if not isinstance(listed, list) or not listed:
            errors.append(f"{project_id}: files must be a non-empty array of relative paths")
            listed = []
        else:
            if listed != sorted(listed):
                errors.append(f"{project_id}: files must be sorted")
            disk_set = set(on_disk)
            listed_set = set(listed)
            if len(listed_set) != len(listed):
                errors.append(f"{project_id}: duplicate paths in files")
            for path in listed:
                if path not in disk_set:
                    errors.append(f"{project_id}: listed file is not on disk: {path}")
            for path in on_disk:
                if path not in listed_set:
                    errors.append(f"{project_id}: on-disk file missing from corpus files: {path}")
        tasks = project.get("tasks")
        if not isinstance(tasks, list) or len(tasks) < 2:
            errors.append(f"{project_id}: expected several tasks")
            continue
        file_set = set(listed)
        task_ids: set[str] = set()
        for task in tasks:
            task_id = task.get("id") if isinstance(task, dict) else None
            if not isinstance(task_id, str) or not task_id:
                errors.append(f"{project_id}: task is missing an id")
                continue
            if task_id in task_ids:
                errors.append(f"{project_id}: duplicate task id {task_id}")
            task_ids.add(task_id)
            text = task.get("task")
            if not isinstance(text, str) or len(text.strip()) < 20:
                errors.append(f"{project_id}/{task_id}: task text is missing or too short")
            relevant = task.get("relevant")
            if not isinstance(relevant, list) or not relevant:
                errors.append(f"{project_id}/{task_id}: relevant must be a non-empty array")
                continue
            if len(set(relevant)) != len(relevant):
                errors.append(f"{project_id}/{task_id}: duplicate relevant paths")
            for path in relevant:
                if path not in file_set:
                    errors.append(f"{project_id}/{task_id}: relevant path is not in the project: {path}")
            if file_set and len(set(relevant)) >= len(file_set):
                errors.append(f"{project_id}/{task_id}: relevant lists every file, so the filter has nothing to drop")
    return errors


def load_project(project_id: str, corpus: dict | None = None) -> tuple[dict, dict[str, str]]:
    corpus = corpus if corpus is not None else load_corpus()
    project = next((item for item in corpus["projects"] if item["id"] == project_id), None)
    if project is None:
        raise KeyError(f"unknown project {project_id}")
    root = (REPO_ROOT / project["root"]).resolve()
    files = {rel: (root / rel).read_text(encoding="utf-8") for rel in project["files"]}
    return project, files


def score_run(run, corpus: dict | None = None) -> list[dict]:
    from filter_relevant import grade_decisions

    corpus = corpus if corpus is not None else load_corpus()
    rows = run if isinstance(run, list) else [run]
    grades = []
    for row in rows:
        project = next((item for item in corpus["projects"] if item["id"] == row["project"]), None)
        if project is None:
            raise KeyError(f"unknown project {row['project']}")
        task = next((item for item in project["tasks"] if item["id"] == row["task"]), None)
        if task is None:
            raise KeyError(f"unknown task {row['project']}/{row['task']}")
        grade = grade_decisions(row.get("decisions") or [], task["relevant"])
        grades.append({"project": project["id"], "task": task["id"], **grade})
    return grades
