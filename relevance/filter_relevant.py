"""Opt-in relevance filter for patchling (Python).

For each file, a cheap LLM answers "is this file relevant to the task?"
with yes or no. Pass only the ``relevant`` map to ``build_environment`` /
``generate_diff`` / ``smartapply``. An answer that is not a clear yes or no
is kept (fail open) and marked uncertain.

``call_llm`` matches ``patchling.call_llm`` and is injected so tests can run
without the package installed.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable

CHEAP_MODEL = "xiaomi/mimo-v2.5-pro-ultraspeed"

PROMPT_INTRO = """You decide whether one source file is relevant to a coding task.
Reply with a single word, yes or no. Do not explain.

A file is relevant only if a correct change for the task would modify it,
or the change would be wrong without seeing the symbols this file defines.
Sharing a topic is not enough."""


def excerpt(content: str, limit: int = 6000) -> str:
    text = "" if content is None else str(content)
    if len(text) <= limit:
        return text
    head = int(limit * 0.7)
    tail = limit - head
    return text[:head] + "\n…[truncated]…\n" + text[-tail:]


def build_prompt(path: str, content: str, task: str, excerpt_chars: int = 6000) -> str:
    return f"{PROMPT_INTRO}\n\nTask:\n{task}\n\nFile: {path}\n{excerpt(content, excerpt_chars)}"


def parse_yes_no(text: str | None) -> bool | None:
    """True for yes, False for no, None when the answer is not clearly either."""
    import re

    source = "" if text is None else str(text)
    source = re.sub(r"<think>[\s\S]*?</think>", " ", source, flags=re.IGNORECASE)
    source = re.sub(r"```[a-zA-Z0-9]*\n?", " ", source)
    source = source.replace("```", " ")
    line = next((part.strip() for part in source.splitlines() if part.strip()), "")
    if not line:
        return None
    match = re.match(r"^(yes|no)\b", line.lower())
    if not match:
        return None
    return match.group(1) == "yes"


def _message_text(response: Any) -> str:
    if isinstance(response, dict):
        content = response["choices"][0]["message"]["content"]
    else:
        content = response.choices[0].message.content
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    return str(content)


def filter_relevant(
    files: dict[str, str],
    task: str,
    *,
    call_llm: Callable[..., Any],
    model: str = CHEAP_MODEL,
    api_key: str | None = None,
    base_url: str | None = None,
    temperature: float = 0,
    max_tokens: int | None = 256,
    concurrency: int = 6,
    excerpt_chars: int = 6000,
    on_decision: Callable[[dict[str, Any]], None] | None = None,
) -> dict[str, Any]:
    """Return ``{"relevant", "dropped", "decisions"}``.

    ``call_llm`` is called as ``patchling.call_llm`` is:
    ``(api_key, base_url, model, messages, max_tokens, temperature)``.
    """
    if call_llm is None:
        raise TypeError("filter_relevant requires call_llm")
    if not task or not str(task).strip():
        raise ValueError("filter_relevant requires a task string")

    paths = list(files)

    def one(path: str) -> dict[str, Any]:
        prompt = build_prompt(path, files[path], task, excerpt_chars)
        response = call_llm(
            api_key,
            base_url,
            model,
            [{"role": "user", "content": prompt}],
            max_tokens,
            temperature,
        )
        answer = _message_text(response).strip()
        verdict = parse_yes_no(answer)
        decision = {
            "path": path,
            "relevant": True if verdict is None else verdict,
            "uncertain": verdict is None,
            "answer": answer,
        }
        if on_decision is not None:
            on_decision(decision)
        return decision

    workers = max(1, min(concurrency, len(paths) or 1))
    if not paths:
        decisions: list[dict[str, Any]] = []
    else:
        with ThreadPoolExecutor(max_workers=workers) as pool:
            decisions = list(pool.map(one, paths))

    relevant: dict[str, str] = {}
    dropped: dict[str, str] = {}
    for decision in decisions:
        content = files[decision["path"]]
        if decision["relevant"]:
            relevant[decision["path"]] = content
        else:
            dropped[decision["path"]] = content
    return {"relevant": relevant, "dropped": dropped, "decisions": decisions}


def grade_decisions(decisions: list[dict[str, Any]], relevant_paths: list[str]) -> dict[str, Any]:
    """Score decisions against a hand-labeled relevant-file list."""
    gold = set(relevant_paths)
    seen: set[str] = set()
    tp = fp = fn = tn = 0
    for decision in decisions:
        path = decision["path"]
        seen.add(path)
        expected = path in gold
        if decision["relevant"] and expected:
            tp += 1
        elif decision["relevant"] and not expected:
            fp += 1
        elif not decision["relevant"] and expected:
            fn += 1
        else:
            tn += 1
    for path in gold:
        if path not in seen:
            fn += 1
    precision = 1.0 if tp + fp == 0 else tp / (tp + fp)
    recall = 1.0 if tp + fn == 0 else tp / (tp + fn)
    return {
        "tp": tp,
        "fp": fp,
        "fn": fn,
        "tn": tn,
        "precision": precision,
        "recall": recall,
    }
