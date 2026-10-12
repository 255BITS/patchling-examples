"""`ink search` — substring match on title and body."""

from __future__ import annotations

from pathlib import Path

from ink.store import load, search


def run(args) -> int:
    book = load(Path(args.notebook))
    for note in search(book, args.text):
        print(f"{note['id']}\t{note['title']}")
    return 0
