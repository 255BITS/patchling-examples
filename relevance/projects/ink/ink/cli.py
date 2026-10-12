"""Argument parsing for ink. `--notebook` is required on every command."""

from __future__ import annotations

import argparse
import sys

from ink.commands import add, export, list_notes, search


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="ink", description="A small notebook CLI.")
    parser.add_argument("--notebook", help="Path to the notebook JSON file.")
    sub = parser.add_subparsers(dest="cmd", required=True)

    add_cmd = sub.add_parser("add", help="Append a note.")
    add_cmd.add_argument("--title", required=True)
    add_cmd.add_argument("--body", default="")
    add_cmd.add_argument("--tag", action="append", default=[], help="Tag to store on the note. Repeatable.")
    add_cmd.set_defaults(func=add.run)

    list_cmd = sub.add_parser("list", help="List titles and tags.")
    list_cmd.set_defaults(func=list_notes.run)

    search_cmd = sub.add_parser("search", help="Find notes by title or body.")
    search_cmd.add_argument("text")
    search_cmd.set_defaults(func=search.run)

    export_cmd = sub.add_parser("export", help="Write a plain-text dump.")
    export_cmd.add_argument("--out", required=True, help="Directory to write notes.txt into.")
    export_cmd.set_defaults(func=export.run)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not args.notebook:
        print("error: --notebook is required", file=sys.stderr)
        return 2
    return args.func(args)
