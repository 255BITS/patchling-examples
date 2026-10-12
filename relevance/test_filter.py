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
from filter_relevant import (
    CHEAP_MODEL,
    DEFAULT_FILTER_MAX_OUTPUT_TOKENS,
    DEFAULT_FILTER_REASONING_EFFORT,
    FILTER_PROMPT_VERSION,
    MemoryCache,
    PROMPT_INSTRUCTIONS,
    build_prompt,
    chat_request_body,
    count_tokens,
    filter_relevant,
    is_binary_content,
    is_ignored_path,
    parse_yes_no,
    truncate_utf8,
)


class ParseTests(unittest.TestCase):
    def test_yes_and_no(self):
        self.assertTrue(parse_yes_no("yes"))
        self.assertTrue(parse_yes_no("Yes."))
        self.assertTrue(parse_yes_no("YES — the route handler"))
        self.assertTrue(parse_yes_no('"yes"'))
        self.assertFalse(parse_yes_no("**no**"))
        self.assertTrue(parse_yes_no("Answer: yes"))
        self.assertFalse(parse_yes_no("Decision: no"))
        self.assertFalse(parse_yes_no("no"))
        self.assertFalse(parse_yes_no("No, this file only styles the page."))
        self.assertTrue(parse_yes_no("```\nyes\n```"))
        self.assertFalse(parse_yes_no("<think>maybe the tests</think>\nno"))
        self.assertFalse(parse_yes_no("\nno"))
        self.assertIsNone(parse_yes_no("I think yes"))
        self.assertIsNone(parse_yes_no("yeah"))
        self.assertIsNone(parse_yes_no("nope"))
        self.assertIsNone(parse_yes_no("There is no doubt this file is required"))
        self.assertIsNone(parse_yes_no(""))
        self.assertIsNone(parse_yes_no("   \n"))

    def test_truncation_and_prompt(self):
        self.assertEqual(truncate_utf8("éX", 2), "é")
        self.assertNotIn("\ufffd", truncate_utf8("éX", 2))
        self.assertEqual(truncate_utf8("€X", 3), "€")
        self.assertEqual(truncate_utf8("€X", 2), "")
        self.assertEqual(truncate_utf8("😀X", 4), "😀")
        self.assertEqual(truncate_utf8("😀X", 3), "")
        self.assertEqual(count_tokens(""), 0)
        self.assertEqual(count_tokens("😀😀😀😀"), 1)
        self.assertEqual(FILTER_PROMPT_VERSION, 3)
        prompt = build_prompt("ink/cli.py", "def main():\n", "Remember the notebook path.")
        self.assertTrue(prompt.startswith(PROMPT_INSTRUCTIONS))
        self.assertIn('starts with exactly "yes" or exactly "no"', prompt)
        self.assertIn("File path:\nink/cli.py\n", prompt)
        self.assertIn("Remember the notebook path.", prompt)
        twin_a = build_prompt("src/lib/note.js", "same", "Wire the receipt note.")
        twin_b = build_prompt("src/notes/note.js", "same", "Wire the receipt note.")
        self.assertNotEqual(twin_a, twin_b)

    def test_binary_and_ignore(self):
        cut = b"a" * 8191 + b"\xc3"
        self.assertEqual(len(cut), 8192)
        self.assertFalse(is_binary_content(cut))
        longer = b"a" * 8191 + b"\xc3\xa9"
        self.assertFalse(is_binary_content(longer))
        self.assertTrue(is_binary_content(b"a\x00b"))
        self.assertTrue(is_binary_content(b"a\xffb"))
        self.assertFalse(is_binary_content("plain text"))
        self.assertFalse(is_ignored_path("src/routes/books.js"))
        self.assertTrue(is_ignored_path("dist/app.min.js"))
        self.assertTrue(is_ignored_path("Package.resolved"))

    def test_chat_body(self):
        body = chat_request_body(
            CHEAP_MODEL,
            [{"role": "user", "content": "hi"}],
            DEFAULT_FILTER_MAX_OUTPUT_TOKENS,
            0,
            DEFAULT_FILTER_REASONING_EFFORT,
        )
        self.assertEqual(body["max_tokens"], 1024)
        self.assertEqual(body["reasoning_effort"], "low")


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
        seen = []

        def call_llm(api_key, base_url, model, messages, max_tokens, temperature, budget_tokens=None):
            seen.append({"model": model, "temperature": temperature, "max_tokens": max_tokens})
            text = messages[0]["content"]
            path = next(item for item in answers if f"File path:\n{item}\n" in text)
            return {"choices": [{"message": {"content": answers[path]}}]}

        result = filter_relevant(
            files,
            "Add a --tag flag to ink search.",
            call_llm=call_llm,
            cache=False,
            log=lambda _message: None,
        )
        self.assertEqual(seen[0]["model"], CHEAP_MODEL)
        self.assertEqual(seen[0]["temperature"], 0)
        self.assertEqual(seen[0]["max_tokens"], 1024)
        self.assertEqual(list(result["relevant"]), ["ink/commands/search.py", "README.md"])
        self.assertEqual(result["files"], result["relevant"])
        self.assertEqual(result["dropped"], {"ink/format.py": "format"})
        unsure = next(row for row in result["decisions"] if row["path"] == "README.md")
        self.assertTrue(unsure["uncertain"])
        self.assertTrue(unsure["failed_open"])
        self.assertTrue(unsure["relevant"])
        self.assertEqual(result["failed_open"], 1)

    def test_narrow_fake_accepts_the_old_signature(self):
        def call_llm(api_key, base_url, model, messages, max_tokens, temperature):
            return {"choices": [{"message": {"content": "yes"}}]}

        result = filter_relevant(
            {"a.py": "x"},
            "Update the helper and its caller.",
            call_llm=call_llm,
            cache=False,
        )
        self.assertEqual(result["relevant"]["a.py"], "x")
        self.assertEqual(result["failed_open"], 0)

    def test_same_content_two_paths(self):
        files = {"unrelated.py": "", "src/target.py": ""}
        calls = []
        cache = MemoryCache()

        def call_llm(api_key, base_url, model, messages, max_tokens, temperature, reasoning_effort=None):
            text = messages[0]["content"]
            calls.append(text)
            if "File path:\nunrelated.py\n" in text:
                return {"choices": [{"message": {"content": "no"}}]}
            if "File path:\nsrc/target.py\n" in text:
                return {"choices": [{"message": {"content": "yes"}}]}
            raise AssertionError(text)

        first = filter_relevant(
            files,
            "Edit the target module only.",
            call_llm=call_llm,
            cache=cache,
            log=lambda _message: None,
        )
        self.assertEqual(len(calls), 2)
        self.assertEqual(first["relevant"]["src/target.py"], "")
        self.assertEqual(first["dropped"]["unrelated.py"], "")
        self.assertNotIn("src/target.py", first["dropped"])

        filter_relevant(
            {"src/target.py": ""},
            "Edit the target module only.",
            call_llm=call_llm,
            cache=cache,
            log=lambda _message: None,
        )
        self.assertEqual(len(calls), 2)

        calls.clear()
        uncached = filter_relevant(
            files,
            "Edit the target module only.",
            call_llm=call_llm,
            cache=False,
            log=lambda _message: None,
        )
        self.assertEqual(len(calls), 2)
        self.assertIn("src/target.py", uncached["relevant"])
        self.assertIn("unrelated.py", uncached["dropped"])

    def test_malformed_answer_is_not_cached(self):
        cache = MemoryCache()
        calls = {"n": 0}

        def call_llm(api_key, base_url, model, messages, max_tokens, temperature, reasoning_effort=None):
            calls["n"] += 1
            return {"choices": [{"message": {"content": "There is no doubt this file is required"}}]}

        opts = {"call_llm": call_llm, "cache": cache, "log": lambda _message: None}
        first = filter_relevant({"a.py": "x"}, "Update the helper and its caller.", **opts)
        second = filter_relevant({"a.py": "x"}, "Update the helper and its caller.", **opts)
        self.assertEqual(calls["n"], 2)
        self.assertEqual(first["failed_open"], 1)
        self.assertEqual(second["failed_open"], 1)
        self.assertEqual(first["relevant"]["a.py"], "x")
        self.assertFalse(first["decisions"][0]["cached"])

    def test_reasoning_effort_rejection_retries_once(self):
        seen = []

        def call_llm(api_key, base_url, model, messages, max_tokens, temperature, reasoning_effort=None):
            seen.append(reasoning_effort)
            if reasoning_effort:
                error = RuntimeError("LLM 400: unsupported parameter reasoning_effort")
                error.status = 400
                raise error
            return {"choices": [{"message": {"content": "no"}}]}

        result = filter_relevant(
            {"a.py": "x"},
            "Update the helper and its caller.",
            call_llm=call_llm,
            cache=False,
            retry_base_ms=0,
            sleep=lambda _ms: None,
        )
        self.assertEqual(seen, ["low", None])
        self.assertEqual(result["dropped"]["a.py"], "x")
        self.assertEqual(result["failed_open"], 0)

    def test_billing_errors_retry_then_fail_open(self):
        calls = {"n": 0}

        def call_llm(api_key, base_url, model, messages, max_tokens, temperature, reasoning_effort=None):
            calls["n"] += 1
            error = RuntimeError("LLM 503: billing reservation")
            error.status = 503
            raise error

        result = filter_relevant(
            {"a.py": "x"},
            "Update the helper and its caller.",
            call_llm=call_llm,
            cache=False,
            retries=2,
            retry_base_ms=0,
            sleep=lambda _ms: None,
        )
        self.assertEqual(calls["n"], 3)
        self.assertEqual(result["failed_open"], 1)
        self.assertTrue(result["decisions"][0]["relevant"])
        self.assertTrue(result["decisions"][0]["uncertain"])
        self.assertEqual(result["relevant"]["a.py"], "x")

    def test_cache_errors_do_not_abort(self):
        logs = []

        class Broken:
            def get(self, _key):
                raise OSError("unreadable")

            def set(self, _key, _record):
                raise OSError("disk full")

        def call_llm(api_key, base_url, model, messages, max_tokens, temperature, reasoning_effort=None):
            return {"choices": [{"message": {"content": "no"}}]}

        result = filter_relevant(
            {"a.py": "x"},
            "Update the helper and its caller.",
            call_llm=call_llm,
            cache=Broken(),
            log=logs.append,
        )
        self.assertEqual(result["dropped"]["a.py"], "x")
        self.assertEqual(result["failed_open"], 0)
        self.assertTrue(any("read failed" in message for message in logs))
        self.assertTrue(any("write failed" in message for message in logs))


class CorpusTests(unittest.TestCase):
    def test_corpus_matches_projects(self):
        self.assertEqual(validate_corpus(load_corpus()), [])

    def test_twin_files_share_bytes_and_one_label(self):
        corpus = load_corpus()
        shelf = next(project for project in corpus["projects"] if project["id"] == "shelf")
        task = next(item for item in shelf["tasks"] if item["id"] == "path-not-content")
        left = (REPO / "relevance/projects/shelf/src/lib/note.js").read_bytes()
        right = (REPO / "relevance/projects/shelf/src/notes/note.js").read_bytes()
        self.assertEqual(left, right)
        self.assertEqual(task["relevant"], ["src/notes/note.js"])
        self.assertNotIn("src/lib/note.js", task["relevant"])

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
        self.assertIn("File path:\nREADME.md", dry.stdout)
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
