# ink

A small command-line notebook. Notes are stored in one JSON file you pass
with `--notebook`. The standard library is enough; nothing to install.

```bash
python -m ink --notebook notes.json add --title "Market" --body "lemons"
python -m ink --notebook notes.json list
python -m ink --notebook notes.json search lemon
python -m ink --notebook notes.json export --out ./out
```

Each note has a title, a body, and zero or more tags (`--tag` on `add` may be
repeated). `export` writes a single plain-text dump.
