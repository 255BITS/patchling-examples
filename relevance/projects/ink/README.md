# ink

A small command-line notebook. Notes are stored in one JSON file you pass
with `--notebook`. Python 3.11 or newer is required. Running the module uses only the standard
library; packaging uses setuptools>=84.2.1 (including its patched vendored
wheel) and wheel>=0.46.2.

```bash
python -m ink --notebook notes.json add --title "Market" --body "lemons"
python -m ink --notebook notes.json list
python -m ink --notebook notes.json search lemon
python -m ink --notebook notes.json export --out ./out
```

Each note has a title, a body, and zero or more tags (`--tag` on `add` may be
repeated). `export` writes a single plain-text dump.
