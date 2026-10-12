"""Read and write the ink config file. The CLI does not consult it yet."""

from __future__ import annotations

import json
from pathlib import Path

DEFAULT_CONFIG = Path.home() / ".inkrc"


def load_config(path: Path | None = None) -> dict:
    target = Path(path) if path else DEFAULT_CONFIG
    if not target.exists():
        return {}
    data = json.loads(target.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("config must be a JSON object")
    return data


def save_config(updates: dict, path: Path | None = None) -> dict:
    target = Path(path) if path else DEFAULT_CONFIG
    current = load_config(target)
    current.update(updates)
    target.write_text(json.dumps(current, indent=2) + "\n", encoding="utf-8")
    return current


def notebook_path(config: dict) -> str | None:
    value = config.get("notebook")
    if isinstance(value, str) and value.strip():
        return value
    return None
