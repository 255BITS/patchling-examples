import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class ExportTests(unittest.TestCase):
    def test_export_writes_one_plain_file(self):
        notebook = Path(__file__).resolve().parent / "_tmp_export.json"
        notebook.write_text(
            json.dumps(
                {
                    "notes": [
                        {"id": "a1", "title": "Market", "body": "lemons", "tags": ["errand"], "created": "2026-01-01T00:00:00Z"},
                        {"id": "b2", "title": "Draft", "body": "chapter", "tags": [], "created": "2026-01-02T00:00:00Z"},
                    ]
                }
            ),
            encoding="utf-8",
        )
        try:
            with tempfile.TemporaryDirectory() as tmp:
                result = subprocess.run(
                    [sys.executable, "-m", "ink", "--notebook", str(notebook), "export", "--out", tmp],
                    cwd=ROOT,
                    capture_output=True,
                    text=True,
                    check=False,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                out = Path(tmp)
                self.assertEqual(sorted(p.name for p in out.iterdir()), ["notes.txt"])
                text = (out / "notes.txt").read_text(encoding="utf-8")
                self.assertIn("Market", text)
                self.assertIn("lemons", text)
                self.assertNotIn("# Market", text)
        finally:
            notebook.unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()
