import json
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def run_ink(*args, notebook):
    return subprocess.run(
        [sys.executable, "-m", "ink", "--notebook", str(notebook), *args],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )


class AddTests(unittest.TestCase):
    def test_empty_body_is_accepted(self):
        notebook = Path(__file__).resolve().parent / "_tmp_add.json"
        if notebook.exists():
            notebook.unlink()
        try:
            result = run_ink("add", "--title", "Blank", "--body", "   ", notebook=notebook)
            self.assertEqual(result.returncode, 0, result.stderr)
            notes = json.loads(notebook.read_text(encoding="utf-8"))["notes"]
            self.assertEqual(len(notes), 1)
            self.assertEqual(notes[0]["body"], "   ")
        finally:
            if notebook.exists():
                notebook.unlink()

    def test_tags_are_stored(self):
        notebook = Path(__file__).resolve().parent / "_tmp_add_tags.json"
        if notebook.exists():
            notebook.unlink()
        try:
            result = run_ink(
                "add",
                "--title", "Market",
                "--body", "lemons",
                "--tag", "errand",
                "--tag", "food",
                notebook=notebook,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            note = json.loads(notebook.read_text(encoding="utf-8"))["notes"][0]
            self.assertEqual(note["tags"], ["errand", "food"])
        finally:
            if notebook.exists():
                notebook.unlink()


if __name__ == "__main__":
    unittest.main()
