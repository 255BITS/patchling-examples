"""Render a note as plain text or as markdown."""

from __future__ import annotations


def as_plain(note: dict) -> str:
    tags = ", ".join(note.get("tags") or [])
    lines = [note.get("title") or "(untitled)"]
    if tags:
        lines.append(f"tags: {tags}")
    body = (note.get("body") or "").rstrip()
    if body:
        lines.append(body)
    return "\n".join(lines)


def as_markdown(note: dict) -> str:
    title = note.get("title") or "(untitled)"
    tags = note.get("tags") or []
    body = (note.get("body") or "").rstrip()
    parts = [f"# {title}"]
    if tags:
        parts.append(" ".join(f"`{tag}`" for tag in tags))
    if body:
        parts.append(body)
    return "\n\n".join(parts) + "\n"
