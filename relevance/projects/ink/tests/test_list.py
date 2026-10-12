import json
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class ListTests(unittest.TestCase):
    def test_list_prints_title_and_tags(self):
        notebook = Path(__file__).resolve().parent / "_tmp_list.json"
        notebook.write_text(
            json.dumps(
                {"notes": [{"id": "a1", "title": "Market", "body": "lemons", "tags": ["errand", "food"], "created": "2026-01-01T00:00:00Z"}]}
            ),
            encoding="utf-8",
        )
        try:
            result = subprocess.run(
                [sys.executable, "-m", "ink", "--notebook", str(notebook), "list"],
                cwd=ROOT,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.strip(), "Market\terrand,food")
        finally:
            notebook.unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()
