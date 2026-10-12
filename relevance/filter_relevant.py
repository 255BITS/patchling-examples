"""Opt-in relevance filter for patchling (Python).

Prompt version 3. One decision per file path. The cache key hashes the
classification inputs: prompt version, model, output-token limit, reasoning
effort, task, file path, and content after truncation. Different paths are
never grouped into one call, even when the bytes match and the cache is off.

A leading standalone yes or no (after the supported wrappers) is a decision.
Anything else is malformed: the file is kept, ``failed_open`` is set, and the
answer is not cached. Timeouts, 5xx, and billing-reservation errors are
retried, then the file is kept. A 4xx that names ``reasoning_effort`` is
retried once without that field.

``call_llm`` is injected. ``post_chat`` is a stdlib client that sends
``max_tokens`` and ``reasoning_effort`` on the chat body. Tests pass a fake
and do not need patchling installed.
"""

from __future__ import annotations

import hashlib
import inspect
import json
import re
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable

FILTER_PROMPT_VERSION = 3
PROMPT_VERSION = FILTER_PROMPT_VERSION

DEFAULT_FILTER_MODEL = "xiaomi/mimo-v2.6-flash"
CHEAP_MODEL = DEFAULT_FILTER_MODEL

DEFAULT_FILTER_CONCURRENCY = 8
DEFAULT_FILTER_MAX_BYTES = 200_000
DEFAULT_FILTER_MAX_TOKENS = 12_000
DEFAULT_FILTER_MAX_OUTPUT_TOKENS = 1024
DEFAULT_FILTER_REASONING_EFFORT = "low"
DEFAULT_FILTER_RETRIES = 2
DEFAULT_FILTER_RETRY_BASE_MS = 200
BINARY_PROBE_BYTES = 8192

# Same list and order as filterRelevant.js. Case-insensitive globs.
DEFAULT_IGNORE_PATTERNS = (
    "**/package-lock.json",
    "**/yarn.lock",
    "**/pnpm-lock.yaml",
    "**/bun.lock",
    "**/bun.lockb",
    "**/npm-shrinkwrap.json",
    "**/Cargo.lock",
    "**/Gemfile.lock",
    "**/poetry.lock",
    "**/Pipfile.lock",
    "**/composer.lock",
    "**/go.sum",
    "**/uv.lock",
    "**/pdm.lock",
    "**/flake.lock",
    "**/pubspec.lock",
    "**/packages.lock.json",
    "**/Package.resolved",
    "**/*.min.js",
    "**/*.min.css",
    "**/*.map",
    "**/dist/**",
    "**/build/**",
    "**/.next/**",
    "**/coverage/**",
    "**/__pycache__/**",
    "**/*.pyc",
    "**/*.pyo",
    "**/*.generated.*",
)

PROMPT_INSTRUCTIONS = "\n".join([
    "You are a relevance filter for a code-editing task.",
    "Decide whether the given file must be read or edited to accomplish the task, or is necessary context for that edit.",
    'Reply with a single line that starts with exactly "yes" or exactly "no", followed by a short reason.',
    'Answer "yes" when the file is likely to need changes or is required context.',
    'Answer "no" when it is unrelated. Do not write a diff.',
])

_ANSWER_PREFIX = re.compile(r"^(?:answer|decision)\s*[:\-]\s*", re.IGNORECASE)
_FENCE_LINE = re.compile(r"^```[a-zA-Z0-9_-]*\s*$")
_LEAD_WRAP = re.compile(r"""^[\s"'`*“”‘’]+""")
_TRAIL_WRAP = re.compile(r"""[\s"'`*“”‘’]+$""")
_LEADING = re.compile(r"^(yes|no)(?=$|[^a-z0-9_])", re.IGNORECASE)
_THINK_BLOCK = re.compile(r"<think\b[^>]*>.*?</think>", re.IGNORECASE | re.DOTALL)
_THINK_OPEN = re.compile(r"<think\b[^>]*>.*\Z", re.IGNORECASE | re.DOTALL)
_THINKING_BLOCK = re.compile(r"<thinking\b[^>]*>.*?</thinking>", re.IGNORECASE | re.DOTALL)
_THINKING_OPEN = re.compile(r"<thinking\b[^>]*>.*\Z", re.IGNORECASE | re.DOTALL)


def count_tokens(text: str | None) -> int:
    """Unicode code points divided by 4. Empty text is 0; anything else is at least 1."""
    chars = "" if text is None else str(text)
    if not chars:
        return 0
    return max(1, len(chars) // 4)


def _utf8_need(lead: int) -> int:
    if lead < 0x80:
        return 1
    if 0xC2 <= lead <= 0xDF:
        return 2
    if 0xE0 <= lead <= 0xEF:
        return 3
    if 0xF0 <= lead <= 0xF4:
        return 4
    return 0


def _sequence_valid(raw: bytes, index: int, need: int) -> bool:
    lead = raw[index]
    for offset in range(1, need):
        if raw[index + offset] & 0xC0 != 0x80:
            return False
    if need == 3:
        nxt = raw[index + 1]
        if lead == 0xE0 and nxt < 0xA0:
            return False
        if lead == 0xED and nxt >= 0xA0:
            return False
    if need == 4:
        nxt = raw[index + 1]
        if lead == 0xF0 and nxt < 0x90:
            return False
        if lead == 0xF4 and nxt >= 0x90:
            return False
    return True


def _prefix_plausible(raw: bytes, index: int, have: int, need: int) -> bool:
    for offset in range(1, have):
        if raw[index + offset] & 0xC0 != 0x80:
            return False
    if have >= 2 and need >= 3:
        nxt = raw[index + 1]
        lead = raw[index]
        if lead == 0xE0 and nxt < 0xA0:
            return False
        if lead == 0xED and nxt >= 0xA0:
            return False
        if lead == 0xF0 and nxt < 0x90:
            return False
        if lead == 0xF4 and nxt >= 0x90:
            return False
    return True


def _sample_is_binary(sample: bytes) -> bool:
    size = len(sample)
    index = 0
    while index < size:
        lead = sample[index]
        if lead == 0:
            return True
        if lead < 0x80:
            index += 1
            continue
        need = _utf8_need(lead)
        if need == 0:
            return True
        if index + need > size:
            have = size - index
            if have > 3:
                return True
            return not _prefix_plausible(sample, index, have, need)
        if not _sequence_valid(sample, index, need):
            return True
        index += need
    return False


def is_binary_content(content: Any) -> bool:
    """NUL or invalid UTF-8 in the first 8192 bytes. An incomplete tail of <= 3 bytes is text."""
    if content is None:
        return False
    if isinstance(content, str):
        raw = content.encode("utf-8")
    elif isinstance(content, (bytes, bytearray)):
        raw = bytes(content)
    else:
        return False
    return _sample_is_binary(raw[:BINARY_PROBE_BYTES])


def truncate_utf8(text: str, max_bytes: int) -> str:
    """Cut on a code-point boundary. Never emits U+FFFD."""
    source = "" if text is None else str(text)
    if max_bytes <= 0:
        return ""
    raw = source.encode("utf-8")
    if len(raw) <= max_bytes:
        return source
    index = 0
    while index < max_bytes:
        need = _utf8_need(raw[index])
        if need == 0 or index + need > max_bytes or not _sequence_valid(raw, index, need):
            break
        index += need
    return raw[:index].decode("utf-8")


def truncate_text(text: str, max_bytes: int | None, max_tokens: int | None) -> str:
    out = "" if text is None else str(text)
    if max_tokens:
        limit = max_tokens * 4
        if len(out) > limit:
            out = out[:limit]
    if max_bytes:
        out = truncate_utf8(out, max_bytes)
    return out


def _glob_to_re(pattern: str) -> re.Pattern[str]:
    regex = ""
    index = 0
    src = pattern.replace("\\", "/").lower()
    while index < len(src):
        if src.startswith("**/", index):
            regex += "(?:.*/)?"
            index += 3
            continue
        if src.startswith("**", index):
            regex += ".*"
            index += 2
            continue
        ch = src[index]
        if ch == "*":
            regex += "[^/]*"
        else:
            if ch in r"\^$+?.()|{}[]":
                regex += "\\"
            regex += ch
        index += 1
    return re.compile(rf"^{regex}$")


def is_ignored_path(path: str, patterns: list[str] | tuple[str, ...] | None = None) -> bool:
    chosen = DEFAULT_IGNORE_PATTERNS if patterns is None else patterns
    normalized = str(path).replace("\\", "/").removeprefix("./").lower()
    return any(_glob_to_re(pattern).search(normalized) or _glob_to_re(pattern).match(normalized) for pattern in chosen)


def _resolve_ignore(ignore: Any) -> list[str]:
    if ignore is False:
        return []
    if ignore is None or ignore is True:
        return list(DEFAULT_IGNORE_PATTERNS)
    if isinstance(ignore, (list, tuple)):
        return [str(pattern) for pattern in ignore]
    raise TypeError("ignore must be true, false, None, or a list of patterns")


def make_cache_key(
    *,
    model: str,
    task: str,
    path: str,
    content: str,
    max_output_tokens: int = DEFAULT_FILTER_MAX_OUTPUT_TOKENS,
    reasoning_effort: str | None = DEFAULT_FILTER_REASONING_EFFORT,
    prompt_version: int = FILTER_PROMPT_VERSION,
) -> str:
    """Hash of the exact classification inputs. ``content`` is the truncated body."""
    effort = "" if reasoning_effort is None else str(reasoning_effort)
    payload = "\n".join([
        str(prompt_version),
        str(model),
        str(max_output_tokens),
        effort,
        str(task),
        str(path),
        str(content),
    ])
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


class MemoryCache:
    """In-memory path-keyed cache. A fresh one is used when cache is omitted."""

    def __init__(self) -> None:
        self._entries: dict[str, dict[str, Any]] = {}

    def get(self, key: str) -> dict[str, Any] | None:
        record = self._entries.get(key)
        return dict(record) if record else None

    def set(self, key: str, record: dict[str, Any]) -> None:
        self._entries[key] = dict(record)

    def put(self, key: str, record: dict[str, Any]) -> None:
        self.set(key, record)


def _resolve_cache(cache: Any) -> Any:
    if cache is False:
        return None
    if cache is None or cache is True:
        return MemoryCache()
    if isinstance(cache, (str, bytes)):
        raise TypeError("pass a cache object with get and set; this example keeps the cache in memory")
    if hasattr(cache, "get") and (hasattr(cache, "set") or hasattr(cache, "put")):
        return cache
    raise TypeError("cache must be an object with get/set, True, False, or None")


def _preview_body(content: str, max_bytes: int | None, max_tokens: int | None) -> str:
    return truncate_text(content, max_bytes, max_tokens)


def build_prompt(
    path: str,
    content: str,
    task: str,
    *,
    max_bytes: int | None = DEFAULT_FILTER_MAX_BYTES,
    max_tokens: int | None = DEFAULT_FILTER_MAX_TOKENS,
) -> str:
    """Prompt the model sees. Identical text in filterRelevant.js."""
    body = _preview_body("" if content is None else str(content), max_bytes, max_tokens)
    return f"{PROMPT_INSTRUCTIONS}\n\nTask:\n{task}\n\nFile path:\n{path}\n\nFile contents:\n{body}"


def _strip_think(text: str) -> str:
    cleaned = _THINK_BLOCK.sub(" ", text)
    cleaned = _THINKING_BLOCK.sub(" ", cleaned)
    cleaned = _THINK_OPEN.sub(" ", cleaned)
    cleaned = _THINKING_OPEN.sub(" ", cleaned)
    cleaned = re.sub(r"</think>", " ", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"</thinking>", " ", cleaned, flags=re.IGNORECASE)
    return cleaned


def _unwrap_fence(text: str) -> str:
    lines = text.splitlines()
    if len(lines) >= 2 and _FENCE_LINE.match(lines[0].strip()) and lines[-1].strip() == "```":
        return "\n".join(lines[1:-1])
    return text


def _unwrap_line(line: str) -> str:
    value = line.strip()
    for _ in range(8):
        nxt = _ANSWER_PREFIX.sub("", value)
        nxt = _LEAD_WRAP.sub("", nxt)
        nxt = _TRAIL_WRAP.sub("", nxt).strip()
        if nxt == value:
            break
        value = nxt
    return value


def parse_yes_no(text: str | None) -> bool | None:
    """True for yes, False for no, None when the answer is malformed."""
    stripped = _unwrap_fence(_strip_think("" if text is None else str(text))).strip()
    line = next((part.strip() for part in stripped.splitlines() if part.strip()), "")
    if not line:
        return None
    match = _LEADING.match(_unwrap_line(line))
    if not match:
        return None
    return match.group(1).lower() == "yes"


def chat_request_body(
    model: str,
    messages: list[dict[str, Any]],
    max_tokens: int | None,
    temperature: float,
    reasoning_effort: str | None = None,
) -> dict[str, Any]:
    """Wire body. Includes reasoning_effort when the filter asked for it."""
    body: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
    }
    if reasoning_effort:
        body["reasoning_effort"] = reasoning_effort
    return body


def post_chat(
    api_key: str | None,
    base_url: str | None,
    model: str,
    messages: list[dict[str, Any]],
    max_tokens: int | None,
    temperature: float = 0,
    reasoning_effort: str | None = None,
    **_ignored: Any,
) -> dict[str, Any]:
    """POST one chat completion. Raises RuntimeError with ``status`` on HTTP errors."""
    root = (base_url or "https://nano-gpt.com/api/v1/").rstrip("/")
    payload = chat_request_body(model, messages, max_tokens, temperature, reasoning_effort)
    request = urllib.request.Request(
        f"{root}/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        error = RuntimeError(f"LLM {exc.code}: {detail}")
        error.status = exc.code  # type: ignore[attr-defined]
        raise error from None


def _status_of(exc: BaseException) -> int | None:
    status = getattr(exc, "status", None)
    if status is None:
        status = getattr(exc, "status_code", None)
    if isinstance(status, int):
        return status
    match = re.search(r"\b([45]\d\d)\b", str(exc))
    return int(match.group(1)) if match else None


def _reasoning_effort_rejected(exc: BaseException) -> bool:
    message = str(exc).lower()
    if "reasoning" not in message:
        return False
    status = _status_of(exc)
    if status is None:
        return "400" in message or "unsupported" in message or "invalid" in message
    return 400 <= status < 500


def _is_transient(exc: BaseException) -> bool:
    status = _status_of(exc)
    if status is not None and 500 <= status <= 599:
        return True
    name = type(exc).__name__.lower()
    if "timeout" in name or name == "timeouterror":
        return True
    message = str(exc).lower()
    if "timeout" in message or "timed out" in message:
        return True
    if "billing reservation" in message:
        return True
    return False


def _call_compatible(call: Callable[..., Any], **kwargs: Any) -> Any:
    try:
        signature = inspect.signature(call)
    except (TypeError, ValueError):
        return call(**kwargs)
    params = signature.parameters
    if any(param.kind == inspect.Parameter.VAR_KEYWORD for param in params.values()):
        return call(**kwargs)
    accepted = {name: value for name, value in kwargs.items() if name in params}
    return call(**accepted)


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


def _decision_row(path: str, **fields: Any) -> dict[str, Any]:
    failed_open = bool(fields.get("failed_open"))
    named = fields.get("decision")
    relevant = named == "yes" or failed_open
    return {
        "path": path,
        "relevant": relevant,
        "uncertain": failed_open,
        "failed_open": failed_open,
        "failedOpen": failed_open,
        "decision": "yes" if relevant else "no",
        "answer": fields.get("answer") or "",
        "cached": bool(fields.get("cached")),
        "skipped_reason": fields.get("skipped_reason"),
        "error": fields.get("error"),
    }


def _default_log(message: str) -> None:
    print(message, file=sys.stderr)


def _default_sleep(ms: float) -> None:
    if ms > 0:
        time.sleep(ms / 1000.0)


def filter_relevant(
    files: dict[str, Any],
    task: str,
    *,
    call_llm: Callable[..., Any],
    model: str = DEFAULT_FILTER_MODEL,
    api_key: str | None = None,
    base_url: str | None = None,
    temperature: float = 0,
    max_output_tokens: int | None = DEFAULT_FILTER_MAX_OUTPUT_TOKENS,
    reasoning_effort: str | None = DEFAULT_FILTER_REASONING_EFFORT,
    concurrency: int = DEFAULT_FILTER_CONCURRENCY,
    max_bytes: int | None = DEFAULT_FILTER_MAX_BYTES,
    max_tokens: int | None = DEFAULT_FILTER_MAX_TOKENS,
    on_oversize: str = "truncate",
    on_binary: str = "exclude",
    ignore: Any = None,
    cache: Any = None,
    retries: int = DEFAULT_FILTER_RETRIES,
    retry_base_ms: int = DEFAULT_FILTER_RETRY_BASE_MS,
    sleep: Callable[[float], None] | None = None,
    log: Callable[[str], None] | None = None,
    on_decision: Callable[[dict[str, Any]], None] | None = None,
) -> dict[str, Any]:
    """Return relevant, dropped, files, decisions, and a failed_open count.

    ``cache=None`` (the default) is a fresh in-memory cache for this call.
    ``cache=False`` turns it off. Pass an object with ``get`` and ``set`` to
    reuse judgments. Keys include the file path.
    """
    if call_llm is None:
        raise TypeError("filter_relevant requires call_llm")
    if not task or not str(task).strip():
        raise ValueError("filter_relevant requires a task string")

    store = _resolve_cache(cache)
    patterns = _resolve_ignore(ignore)
    pause = sleep or _default_sleep
    warn = log or _default_log
    paths = list(files)

    def cache_get(key: str) -> dict[str, Any] | None:
        if store is None:
            return None
        try:
            hit = store.get(key)
        except Exception as exc:
            warn(f"relevance cache read failed: {exc}")
            return None
        if not hit or hit.get("decision") not in ("yes", "no") or hit.get("failed_open") or hit.get("failedOpen"):
            return None
        return hit

    def cache_put(key: str, record: dict[str, Any]) -> None:
        if store is None:
            return
        try:
            if hasattr(store, "set"):
                store.set(key, record)
            else:
                store.put(key, record)
        except Exception as exc:
            warn(f"relevance cache write failed: {exc}")

    def ask(messages: list[dict[str, str]]) -> Any:
        effort = reasoning_effort
        stripped = False
        attempt = 0
        while True:
            try:
                return _call_compatible(
                    call_llm,
                    api_key=api_key,
                    base_url=base_url,
                    model=model,
                    messages=messages,
                    max_tokens=max_output_tokens,
                    temperature=temperature,
                    reasoning_effort=effort,
                )
            except Exception as exc:
                if effort and not stripped and _reasoning_effort_rejected(exc):
                    stripped = True
                    effort = None
                    continue
                if attempt >= retries or not _is_transient(exc):
                    raise
                wait = min(retry_base_ms * (2 ** attempt), 30_000)
                attempt += 1
                if wait > 0:
                    pause(wait)

    def one(path: str) -> dict[str, Any]:
        content = files[path]
        text = content if isinstance(content, str) else ""
        if is_ignored_path(path, patterns):
            return _decision_row(path, decision="no", skipped_reason="ignored")
        if is_binary_content(content):
            if on_binary == "include":
                return _decision_row(path, decision="yes", skipped_reason="binary")
            return _decision_row(path, decision="no", skipped_reason="binary")
        body = _preview_body(text, max_bytes, max_tokens)
        if body != text and on_oversize == "exclude":
            return _decision_row(path, decision="no", skipped_reason="oversize")
        if body != text and on_oversize == "include":
            return _decision_row(path, decision="yes", skipped_reason="oversize")
        key = make_cache_key(
            model=model,
            task=task,
            path=path,
            content=body,
            max_output_tokens=max_output_tokens if max_output_tokens is not None else 0,
            reasoning_effort=reasoning_effort or "",
            prompt_version=FILTER_PROMPT_VERSION,
        )
        hit = cache_get(key)
        if hit:
            row = _decision_row(path, decision=hit["decision"], answer=hit.get("answer") or "", cached=True)
            if on_decision is not None:
                on_decision(row)
            return row
        prompt = build_prompt(path, body, task, max_bytes=None, max_tokens=None)
        messages = [{"role": "user", "content": prompt}]
        try:
            response = ask(messages)
        except Exception as exc:
            row = _decision_row(path, failed_open=True, error=str(exc))
            if on_decision is not None:
                on_decision(row)
            return row
        answer = _message_text(response).strip()
        verdict = parse_yes_no(answer)
        if verdict is None:
            row = _decision_row(path, failed_open=True, answer=answer)
            if on_decision is not None:
                on_decision(row)
            return row
        row = _decision_row(path, decision="yes" if verdict else "no", answer=answer)
        cache_put(key, {"decision": row["decision"], "answer": answer})
        if on_decision is not None:
            on_decision(row)
        return row

    if not paths:
        decisions: list[dict[str, Any]] = []
    else:
        workers = max(1, min(concurrency, len(paths)))
        with ThreadPoolExecutor(max_workers=workers) as pool:
            decisions = list(pool.map(one, paths))

    relevant: dict[str, Any] = {}
    dropped: dict[str, Any] = {}
    failed_open = 0
    for decision in decisions:
        if decision["failed_open"]:
            failed_open += 1
        content = files[decision["path"]]
        if decision["relevant"]:
            relevant[decision["path"]] = content
        else:
            dropped[decision["path"]] = content
    return {
        "relevant": relevant,
        "dropped": dropped,
        "files": relevant,
        "decisions": decisions,
        "failed_open": failed_open,
        "failedOpen": failed_open,
        "model": model,
    }


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
