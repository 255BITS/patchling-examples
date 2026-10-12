"""`ink add` — append a note. Empty bodies are currently accepted."""

from __future__ import annotations

from pathlib import Path

from ink.store import add_note, load, save


def run(args) -> int:
    book = load(Path(args.notebook))
    note = add_note(book, args.title, args.body, list(args.tag or []))
    save(Path(args.notebook), book)
    print(note["id"])
    return 0
