import json
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def write_notebook(path: Path):
    path.write_text(
        json.dumps(
            {
                "notes": [
                    {"id": "a1", "title": "Market", "body": "lemons and bread", "tags": ["errand"], "created": "2026-01-01T00:00:00Z"},
                    {"id": "b2", "title": "Draft", "body": "chapter two", "tags": ["writing"], "created": "2026-01-02T00:00:00Z"},
                ]
            }
        ),
        encoding="utf-8",
    )


class SearchTests(unittest.TestCase):
    def test_search_matches_body(self):
        notebook = Path(__file__).resolve().parent / "_tmp_search.json"
        write_notebook(notebook)
        try:
            result = subprocess.run(
                [sys.executable, "-m", "ink", "--notebook", str(notebook), "search", "lemon"],
                cwd=ROOT,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("a1\tMarket", result.stdout)
            self.assertNotIn("Draft", result.stdout)
        finally:
            notebook.unlink(missing_ok=True)

    def test_search_has_no_tag_flag(self):
        result = subprocess.run(
            [sys.executable, "-m", "ink", "--notebook", "unused.json", "search", "--tag", "errand", "lemon"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unrecognized arguments", result.stderr)


if __name__ == "__main__":
    unittest.main()
