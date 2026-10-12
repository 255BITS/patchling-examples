"""JSON notebook: a list of notes with title, body, and tags."""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path


def empty() -> dict:
    return {"notes": []}


def load(path: Path) -> dict:
    target = Path(path)
    if not target.exists():
        return empty()
    data = json.loads(target.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or not isinstance(data.get("notes"), list):
        raise ValueError(f"{target} is not an ink notebook")
    return data


def save(path: Path, book: dict) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(book, indent=2) + "\n", encoding="utf-8")


def add_note(book: dict, title: str, body: str, tags: list[str] | None = None) -> dict:
    note = {
        "id": uuid.uuid4().hex[:8],
        "title": title,
        "body": body,
        "tags": list(tags or []),
        "created": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    book["notes"].append(note)
    return note


def search(book: dict, text: str) -> list[dict]:
    """Match title or body. Tags are stored but not queried."""
    needle = text.casefold()
    hits = []
    for note in book["notes"]:
        hay = f"{note.get('title', '')}\n{note.get('body', '')}".casefold()
        if needle in hay:
            hits.append(note)
    return hits
