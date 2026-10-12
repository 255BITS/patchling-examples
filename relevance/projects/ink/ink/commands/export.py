"""`ink export` — write every note into one plain-text file."""

from __future__ import annotations

from pathlib import Path

from ink.format import as_plain
from ink.store import load


def run(args) -> int:
    book = load(Path(args.notebook))
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    chunks = [as_plain(note) for note in book["notes"]]
    text = "\n\n".join(chunks)
    if text:
        text += "\n"
    (out / "notes.txt").write_text(text, encoding="utf-8")
    print(str(out / "notes.txt"))
    return 0
