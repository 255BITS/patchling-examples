"""`ink list` — print title and tags, one note per line."""

from __future__ import annotations

from pathlib import Path

from ink.store import load


def run(args) -> int:
    book = load(Path(args.notebook))
    for note in book["notes"]:
        tags = ",".join(note.get("tags") or [])
        print(f"{note['title']}\t{tags}")
    return 0
