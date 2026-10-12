"""Parser, filter, corpus, and ink-sample checks. No network and no patchling install."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(REPO / "relevance" / "projects" / "ink"))

from corpus_check import load_corpus, validate_corpus, score_run
from filter_relevant import CHEAP_MODEL, PROMPT_INTRO, build_prompt, excerpt, filter_relevant, parse_yes_no


class ParseTests(unittest.TestCase):
    def test_yes_and_no(self):
        self.assertTrue(parse_yes_no("yes"))
        self.assertTrue(parse_yes_no("Yes."))
        self.assertTrue(parse_yes_no("YES — the route handler"))
        self.assertFalse(parse_yes_no("no"))
        self.assertFalse(parse_yes_no("No, this file only styles the page."))
        self.assertTrue(parse_yes_no("```\nyes\n```"))
        self.assertFalse(parse_yes_no("<think>maybe the tests</think>\nno"))
        self.assertIsNone(parse_yes_no("I think yes"))
        self.assertIsNone(parse_yes_no("yeah"))
        self.assertIsNone(parse_yes_no(""))
        self.assertIsNone(parse_yes_no("   \n"))

    def test_excerpt_and_prompt(self):
        self.assertEqual(excerpt("abc", 10), "abc")
        cut = excerpt("a" * 50 + "MIDDLE" + "b" * 50, 20)
        self.assertIn("…[truncated]…", cut)
        self.assertNotIn("MIDDLE", cut)
        prompt = build_prompt("ink/cli.py", "def main():\n", "Remember the notebook path.")
        self.assertIn(PROMPT_INTRO, prompt)
        self.assertIn("Reply with a single word, yes or no.", prompt)
        self.assertIn("Sharing a topic is not enough.", prompt)
        self.assertIn("File: ink/cli.py", prompt)
        self.assertIn("Remember the notebook path.", prompt)


class FilterTests(unittest.TestCase):
    def test_keeps_yes_drops_no_fails_open(self):
        files = {
            "ink/commands/search.py": "search",
            "ink/format.py": "format",
            "README.md": "readme",
        }
        answers = {
            "ink/commands/search.py": "yes",
            "ink/format.py": "no",
            "README.md": "perhaps",
        }

        def call_llm(api_key, base_url, model, messages, max_tokens, temperature, budget_tokens=None):
            self.assertEqual(model, CHEAP_MODEL)
            self.assertEqual(temperature, 0)
            text = messages[0]["content"]
            path = next(item for item in answers if f"File: {item}\n" in text)
            return {"choices": [{"message": {"content": answers[path]}}]}

        result = filter_relevant(files, "Add a --tag flag to ink search.", call_llm=call_llm)
        self.assertEqual(list(result["relevant"]), ["ink/commands/search.py", "README.md"])
        self.assertEqual(result["dropped"], {"ink/format.py": "format"})
        unsure = next(row for row in result["decisions"] if row["path"] == "README.md")
        self.assertTrue(unsure["uncertain"])
        self.assertTrue(unsure["relevant"])


class CorpusTests(unittest.TestCase):
    def test_corpus_matches_projects(self):
        self.assertEqual(validate_corpus(load_corpus()), [])

    def test_score_run(self):
        grades = score_run(
            {
                "project": "pantry",
                "task": "detail-meta",
                "decisions": [
                    {"path": "src/components/RecipeDetail.jsx", "relevant": True},
                    {"path": "src/data/recipes.js", "relevant": True},
                    {"path": "src/App.jsx", "relevant": False},
                ],
            }
        )
        self.assertEqual(grades[0]["tp"], 1)
        self.assertEqual(grades[0]["fp"], 1)
        self.assertEqual(grades[0]["fn"], 0)

    def test_example_check_and_dry_run(self):
        check = subprocess.run([sys.executable, str(HERE / "example.py"), "--check"], capture_output=True, text=True)
        self.assertEqual(check.returncode, 0, check.stderr)
        self.assertIn("corpus ok", check.stdout)
        dry = subprocess.run(
            [sys.executable, str(HERE / "example.py"), "--project", "ink", "--task", "reject-empty", "--dry-run"],
            capture_output=True,
            text=True,
        )
        self.assertEqual(dry.returncode, 0, dry.stderr)
        self.assertIn("File: README.md", dry.stdout)
        self.assertIn("exit with status 2", dry.stdout)


class InkSampleTests(unittest.TestCase):
    """The Python CLI sample is the 'before' state the labels describe."""

    def test_ink_unittest_modules(self):
        result = subprocess.run(
            [sys.executable, "-m", "unittest", "discover", "-s", "tests", "-t", "."],
            cwd=REPO / "relevance" / "projects" / "ink",
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)

    def test_missing_notebook_is_an_error(self):
        result = subprocess.run(
            [sys.executable, "-m", "ink", "list"],
            cwd=REPO / "relevance" / "projects" / "ink",
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("--notebook is required", result.stderr)

    def test_format_markdown_is_unused_by_export(self):
        from ink.format import as_markdown

        text = as_markdown({"title": "Market", "body": "lemons", "tags": ["errand"]})
        self.assertTrue(text.startswith("# Market\n"))
        export = (REPO / "relevance" / "projects" / "ink" / "ink" / "commands" / "export.py").read_text(encoding="utf-8")
        self.assertIn("as_plain", export)
        self.assertNotIn("as_markdown", export)


class ScoreCliTests(unittest.TestCase):
    def test_score_flag(self):
        payload = {
            "project": "shelf",
            "task": "request-id",
            "decisions": [
                {"path": "src/middleware/requestLog.js", "relevant": True, "answer": "yes"},
                {"path": "src/middleware/errors.js", "relevant": False, "answer": "no"},
                {"path": "test/requestLog.test.js", "relevant": True, "answer": "yes"},
            ],
        }
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "run.json"
            path.write_text(json.dumps(payload), encoding="utf-8")
            result = subprocess.run(
                [sys.executable, str(HERE / "example.py"), "--score", str(path)],
                capture_output=True,
                text=True,
            )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("shelf/request-id", result.stdout)
        self.assertIn("precision 100.0%", result.stdout)
        self.assertIn("recall 100.0%", result.stdout)


if __name__ == "__main__":
    unittest.main()
