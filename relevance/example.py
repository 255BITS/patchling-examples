#!/usr/bin/env python3
"""Runnable usage of filter_relevant, then generate_diff / smartapply.

    python relevance/example.py --check
    python relevance/example.py --list
    python relevance/example.py --project ink --task search-tag --dry-run
    GPTDIFF_LLM_API_KEY=sk-nano-... python relevance/example.py --project ink --task search-tag
    python relevance/example.py --project ink --task search-tag --apply --out /tmp/ink-filter.json

--check and --dry-run do not call a model. A live run asks the cheap model
once per file, then (with --apply) sends only the yes files to generate_diff
and smartapply. Sample projects are never written.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# Allow `python relevance/example.py` from the repo root without installing.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from corpus_check import load_corpus, load_project, score_run, validate_corpus
from filter_relevant import CHEAP_MODEL, build_prompt, filter_relevant, post_chat


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the opt-in relevance filter on a labeled sample project.")
    parser.add_argument("--check", action="store_true", help="validate the hand-labeled corpus and exit")
    parser.add_argument("--list", action="store_true", help="list projects and tasks")
    parser.add_argument("--score", metavar="FILE", help="score a decisions JSON file written by --out")
    parser.add_argument("--project", help="sample project id (shelf, ink, pantry)")
    parser.add_argument("--task", help="task id inside that project")
    parser.add_argument("--dry-run", action="store_true", help="print the yes/no prompt for the first file and exit")
    parser.add_argument("--apply", action="store_true", help="after filtering, generate_diff + smartapply on the kept files")
    parser.add_argument("--model", default=CHEAP_MODEL, help="cheap filter model (prompt v3, 1024 output tokens, reasoning effort low)")
    parser.add_argument("--diff-model", default=None, help="model for generate_diff / smartapply")
    parser.add_argument("--out", help="write {project, task, decisions} JSON a benchmark can score")
    return parser.parse_args(argv)


def cmd_check(corpus: dict) -> int:
    errors = validate_corpus(corpus)
    if errors:
        for error in errors:
            print(f"error: {error}", file=sys.stderr)
        return 1
    print(f"corpus ok ({len(corpus['projects'])} projects)")
    return 0


def cmd_list(corpus: dict) -> int:
    for project in corpus["projects"]:
        print(f"{project['id']}  {project['name']}")
        for task in project["tasks"]:
            print(f"  {task['id']}")
            print(f"    relevant: {', '.join(task['relevant'])}")
    return 0


def live_filter(files: dict[str, str], task: str, model: str):
    try:
        import patchling
    except ImportError:
        print("error: pip install patchling  (needed for a live filter; --check and --dry-run do not need it)", file=sys.stderr)
        return None
    api_key = patchling.resolve_api_key()
    if not api_key:
        print("error: set GPTDIFF_LLM_API_KEY, or pass --dry-run to preview the prompt", file=sys.stderr)
        return None
    base_url = patchling.resolve_base_url()

    def on_decision(decision: dict) -> None:
        if decision["uncertain"]:
            mark = "keep?"
        elif decision["relevant"]:
            mark = "yes"
        else:
            mark = "no"
        print(f"{mark:<6} {decision['path']}")

    result = filter_relevant(
        files,
        task,
        call_llm=post_chat,
        model=model,
        api_key=api_key,
        base_url=base_url,
        on_decision=on_decision,
    )
    return patchling, api_key, base_url, result


def apply_diff(patchling, task: str, relevant: dict[str, str], diff_model: str, api_key: str, base_url: str) -> None:
    kept = list(relevant)
    if not kept:
        print("filter kept nothing; skipping generate_diff")
        return
    print(f"\ngenerate_diff on {len(kept)} file(s): {', '.join(kept)}")
    diff = patchling.generate_diff(
        patchling.build_environment(relevant),
        task,
        model=diff_model,
        api_key=api_key,
        base_url=base_url,
    )
    print(diff or "(empty diff)")
    print("\nsmartapply on the same kept map")
    updated = patchling.smartapply(diff, relevant, model=diff_model, api_key=api_key, base_url=base_url)
    changed = []
    for path in list(dict.fromkeys([*relevant.keys(), *updated.keys()])):
        if updated.get(path) != relevant.get(path):
            changed.append(path)
    print(f"changed: {', '.join(changed)}" if changed else "smartapply produced no change")


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    corpus = load_corpus()
    if args.check:
        return cmd_check(corpus)
    if args.list:
        return cmd_list(corpus)
    if args.score:
        errors = validate_corpus(corpus)
        if errors:
            for error in errors:
                print(f"error: {error}", file=sys.stderr)
            return 1
        payload = json.loads(Path(args.score).read_text(encoding="utf-8"))
        for grade in score_run(payload, corpus):
            precision = grade["precision"] * 100
            recall = grade["recall"] * 100
            print(
                f"{grade['project']}/{grade['task']}  precision {precision:.1f}%  recall {recall:.1f}%  "
                f"tp {grade['tp']} fp {grade['fp']} fn {grade['fn']} tn {grade['tn']}"
            )
        return 0
    if not args.project or not args.task:
        print("error: pass --project and --task, or --check / --list", file=sys.stderr)
        return 1
    errors = validate_corpus(corpus)
    if errors:
        for error in errors:
            print(f"error: {error}", file=sys.stderr)
        return 1
    try:
        project, files = load_project(args.project, corpus)
    except KeyError as err:
        print(f"error: {err}", file=sys.stderr)
        return 1
    task = next((item for item in project["tasks"] if item["id"] == args.task), None)
    if task is None:
        print(f"error: {args.project} has no task {args.task}", file=sys.stderr)
        return 1

    paths = list(files)
    print(f"{project['name']} / {task['id']}")
    print(f"{len(paths)} files. Hand-labeled relevant: {', '.join(task['relevant'])}")
    if args.dry_run:
        first = paths[0]
        print(f"\n--- prompt for {first} ---\n")
        print(build_prompt(first, files[first], task["task"]))
        print(f"\n(dry run: {len(paths)} prompts would be sent, one per file)")
        return 0

    live = live_filter(files, task["task"], args.model)
    if live is None:
        return 2
    patchling, api_key, base_url, result = live
    kept = list(result["relevant"])
    print(f"\nkept {len(kept)} / {len(paths)}")
    if args.out:
        payload = {"project": project["id"], "task": task["id"], "decisions": result["decisions"]}
        Path(args.out).write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
        print(f"wrote {args.out}")
    if args.apply:
        apply_diff(patchling, task["task"], result["relevant"], args.diff_model or args.model, api_key, base_url)
    return 0


if __name__ == "__main__":
    sys.exit(main())
