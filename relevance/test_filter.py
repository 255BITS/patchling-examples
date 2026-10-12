"""Parser, filter, corpus, and ink-sample checks. No network and no patchling install."""

from __future__ import annotations

import hashlib
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
    decode_utf8_bytes,
    encode_cache_key,
    filter_relevant,
    is_binary_content,
    is_ignored_path,
    make_cache_key,
    parse_yes_no,
    truncate_text,
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
        self.assertIsNone(parse_yes_no("yes?"))
        self.assertTrue(parse_yes_no("__yes__"))
        self.assertFalse(parse_yes_no("“no”"))
        self.assertFalse(parse_yes_no(" no, this file is irrelevant \nyes, the function to rename is here"))
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
        self.assertEqual(count_tokens("abcd"), 1)
        self.assertEqual(count_tokens("abcde"), 2)
        self.assertEqual(count_tokens("😀😀😀😀"), 1)
        self.assertEqual(truncate_text("abc😀def", None, 1), "abc😀")
        self.assertEqual(truncate_text("中文测试额外", None, 1), "中文测试")
        self.assertEqual(truncate_text("cafe\u0301XYZ", None, 1), "cafe")
        self.assertNotIn("\ufffd", truncate_text("abc😀def", None, 1))
        self.assertEqual(encode_cache_key(["ab"]), b"2:ab\n")
        self.assertNotEqual(encode_cache_key(["a", "b"]), encode_cache_key(["ab"]))
        full = make_cache_key(
            model="m", task="edit", path="a.py", content="abc",
            max_output_tokens=1024, reasoning_effort="low", prompt_version=3, mode="full", note="",
        )
        cut = make_cache_key(
            model="m", task="edit", path="a.py", content="abc",
            max_output_tokens=1024, reasoning_effort="low", prompt_version=3, mode="truncated", note="",
        )
        self.assertNotEqual(full, cut)
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
        self.assertTrue(is_ignored_path("src/app.min.mjs"))

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

    def test_changed_bytes_at_the_same_path(self):
        calls = []
        cache = MemoryCache()

        def call_llm(api_key, base_url, model, messages, max_tokens, temperature, reasoning_effort=None):
            calls.append(messages[0]["content"])
            return {"choices": [{"message": {"content": "yes"}}]}

        task = "Edit the target module only."
        alpha = "alpha = 1\n".encode()
        beta = "beta = 2\n".encode()
        first = filter_relevant(
            {"src/target.py": alpha},
            task,
            call_llm=call_llm,
            cache=cache,
            log=lambda _message: None,
        )
        second = filter_relevant(
            {"src/target.py": beta},
            task,
            call_llm=call_llm,
            cache=cache,
            log=lambda _message: None,
        )
        self.assertEqual(len(calls), 2)
        self.assertIn("alpha = 1", calls[0])
        self.assertIn("beta = 2", calls[1])
        self.assertFalse(first["decisions"][0]["cached"])
        self.assertFalse(second["decisions"][0]["cached"])
        self.assertEqual(first["relevant"]["src/target.py"], "alpha = 1\n")
        self.assertEqual(second["relevant"]["src/target.py"], "beta = 2\n")
        self.assertEqual(decode_utf8_bytes(alpha), "alpha = 1\n")
        third = filter_relevant(
            {"src/target.py": beta},
            task,
            call_llm=call_llm,
            cache=cache,
            log=lambda _message: None,
        )
        self.assertEqual(len(calls), 2)
        self.assertTrue(third["decisions"][0]["cached"])
        bad = filter_relevant(
            {"a.bin": bytes([0x61, 0xFF])},
            task,
            call_llm=call_llm,
            cache=False,
            log=lambda _message: None,
        )
        self.assertEqual(len(calls), 2)
        self.assertEqual(bad["decisions"][0]["skipped_reason"], "binary")
        self.assertEqual(bad["decisions"][0]["skippedReason"], "binary")
        self.assertNotIn("a.bin", bad["relevant"])

    def test_broken_envelope_fails_open_uncached(self):
        cache = MemoryCache()
        bad = [
            None,
            "not-json",
            '{"choices":[{"message":{"content":"yes"}}]}',
            {},
            {"choices": []},
            {"choices": [{}]},
            {"choices": [{"message": {}}]},
            {"choices": [{"message": {"content": None}}]},
            {"choices": [{"message": {"content": ""}}]},
        ]
        calls = {"n": 0}

        def call_llm(api_key, base_url, model, messages, max_tokens, temperature, reasoning_effort=None):
            calls["n"] += 1
            return bad[min(calls["n"], len(bad)) - 1]

        opts = {"call_llm": call_llm, "cache": cache, "log": lambda _message: None}
        first = filter_relevant({"a.py": "x"}, "Update the helper and its caller.", **opts)
        second = filter_relevant({"a.py": "x"}, "Update the helper and its caller.", **opts)
        self.assertEqual(calls["n"], 2)
        self.assertEqual(first["failed_open"], 1)
        self.assertEqual(second["failed_open"], 1)
        self.assertEqual(first["relevant"]["a.py"], "x")
        self.assertFalse(first["decisions"][0]["cached"])
        for response in bad:
            def one_response(api_key, base_url, model, messages, max_tokens, temperature, reasoning_effort=None, response=response):
                return response

            result = filter_relevant(
                {"a.py": "x"},
                "Update the helper and its caller.",
                call_llm=one_response,
                cache=False,
                log=lambda _message: None,
            )
            self.assertEqual(result["failed_open"], 1, response)
            self.assertEqual(result["relevant"]["a.py"], "x")

    def test_rejected_effort_is_stored_under_the_empty_key(self):
        cache = MemoryCache()
        calls = {"n": 0}

        def call_llm(api_key, base_url, model, messages, max_tokens, temperature, reasoning_effort=None):
            calls["n"] += 1
            if reasoning_effort:
                error = RuntimeError("LLM 400: unsupported parameter reasoning_effort")
                error.status = 400
                raise error
            return {"choices": [{"message": {"content": "no"}}]}

        opts = {
            "call_llm": call_llm,
            "cache": cache,
            "log": lambda _message: None,
            "retry_base_ms": 0,
            "sleep": lambda _ms: None,
        }
        first = filter_relevant({"a.py": "x"}, "Update the helper and its caller.", **opts)
        self.assertEqual(calls["n"], 2)
        self.assertEqual(first["dropped"]["a.py"], "x")
        second = filter_relevant({"a.py": "x"}, "Update the helper and its caller.", **opts)
        self.assertEqual(calls["n"], 2)
        self.assertTrue(second["decisions"][0]["cached"])
        self.assertEqual(second["dropped"]["a.py"], "x")

    def test_typeerror_is_not_a_rejected_effort(self):
        calls = {"n": 0}

        def call_llm(api_key, base_url, model, messages, max_tokens, temperature, reasoning_effort=None):
            calls["n"] += 1
            raise TypeError("unsupported")

        result = filter_relevant(
            {"a.py": "x"},
            "Update the helper and its caller.",
            call_llm=call_llm,
            cache=False,
            log=lambda _message: None,
        )
        self.assertEqual(calls["n"], 1)
        self.assertEqual(result["failed_open"], 1)
        self.assertEqual(result["relevant"]["a.py"], "x")

    def test_invalid_utf8_after_the_probe_is_binary_and_keeps_original_bytes(self):
        payload = b"a" * 8192 + b"\xffTAIL"
        self.assertTrue(is_binary_content(payload))
        calls = {"n": 0}

        def call_llm(api_key, base_url, model, messages, max_tokens, temperature, reasoning_effort=None):
            calls["n"] += 1
            return {"choices": [{"message": {"content": "yes"}}]}

        excluded = filter_relevant(
            {"a.bin": payload},
            "Edit the target module only.",
            call_llm=call_llm,
            cache=False,
            log=lambda _message: None,
        )
        self.assertEqual(calls["n"], 0)
        self.assertEqual(excluded["decisions"][0]["skipped_reason"], "binary")
        self.assertNotIn("a.bin", excluded["relevant"])
        self.assertEqual(excluded["dropped"]["a.bin"], payload)
        self.assertEqual(excluded["dropped"]["a.bin"][8192], 0xFF)
        self.assertEqual(excluded["dropped"]["a.bin"][8193:], b"TAIL")

        included = filter_relevant(
            {"a.bin": payload},
            "Edit the target module only.",
            call_llm=call_llm,
            cache=False,
            log=lambda _message: None,
            on_binary="include",
        )
        self.assertEqual(calls["n"], 0)
        self.assertEqual(included["relevant"]["a.bin"], payload)
        self.assertTrue(included["decisions"][0]["relevant"])
        self.assertEqual(included["relevant"]["a.bin"][8192], 0xFF)

    def test_non_string_message_content_fails_open_uncached(self):
        cache = MemoryCache()
        calls = {"n": 0}

        def call_llm(api_key, base_url, model, messages, max_tokens, temperature, reasoning_effort=None):
            calls["n"] += 1
            return {"choices": [{"message": {"content": ["no"]}}]}

        opts = {"call_llm": call_llm, "cache": cache, "log": lambda _message: None}
        task = "Update the helper and its caller."
        first = filter_relevant({"a.py": "x"}, task, **opts)
        second = filter_relevant({"a.py": "x"}, task, **opts)
        self.assertEqual(calls["n"], 2)
        self.assertEqual(first["failed_open"], 1)
        self.assertEqual(second["failed_open"], 1)
        self.assertFalse(first["decisions"][0]["cached"])
        self.assertFalse(second["decisions"][0]["cached"])
        self.assertEqual(first["relevant"]["a.py"], "x")
        self.assertNotEqual(first["decisions"][0]["answer"], "no")

    def test_quoted_no_followed_by_a_reason_is_no(self):
        for raw in ("**no** unrelated", '"no" unrelated', "“no” — unrelated"):
            self.assertIs(parse_yes_no(raw), False, raw)
        self.assertIsNone(parse_yes_no("yes?"))
        self.assertIsNone(parse_yes_no("nope"))
        self.assertIsNone(parse_yes_no("no**unrelated"))
        self.assertTrue(parse_yes_no("YES — the route handler"))
        self.assertIs(parse_yes_no("No,"), False)

    def test_leading_utf8_bom_is_preserved(self):
        raw = bytes([0xEF, 0xBB, 0xBF, 0x61, 0x62, 0x63])
        text = decode_utf8_bytes(raw)
        self.assertEqual(text, "\ufeffabc")
        self.assertEqual(ord(text[0]), 0xFEFF)
        self.assertEqual(truncate_utf8(text, 3), "\ufeff")
        self.assertEqual(count_tokens("\ufeffabcd"), 2)
        self.assertEqual(truncate_text(text, None, 1), "\ufeffabc")
        seen = {}

        def call_llm(api_key, base_url, model, messages, max_tokens, temperature, reasoning_effort=None):
            seen["body"] = messages[0]["content"]
            return {"choices": [{"message": {"content": "yes"}}]}

        result = filter_relevant(
            {"a.py": raw},
            "Update the helper and its caller.",
            call_llm=call_llm,
            cache=False,
            log=lambda _message: None,
        )
        self.assertEqual(result["relevant"]["a.py"], "\ufeffabc")
        self.assertIn("\ufeffabc", seen["body"])
        key = make_cache_key(
            model="m",
            task="edit",
            path="a.js",
            content=text,
            max_output_tokens=1024,
            reasoning_effort="low",
            prompt_version=3,
            mode="full",
            note="",
        )
        self.assertEqual(len(key), 64)

    def test_ordinary_yes_is_requested_once(self):
        calls = {"n": 0}

        def call_llm(api_key, base_url, model, messages, max_tokens, temperature, reasoning_effort=None):
            calls["n"] += 1
            return {"choices": [{"message": {"content": "yes"}}]}

        result = filter_relevant(
            {"a.py": "x"},
            "Update the helper and its caller.",
            call_llm=call_llm,
            cache=False,
            log=lambda _message: None,
        )
        self.assertEqual(calls["n"], 1)
        self.assertEqual(result["failed_open"], 0)
        self.assertIsNone(result["decisions"][0]["skipped_reason"])

    def test_minified_modules_are_ignored(self):
        calls = {"n": 0}

        def call_llm(api_key, base_url, model, messages, max_tokens, temperature, reasoning_effort=None):
            calls["n"] += 1
            self.assertIn("File path:\nsrc/app.js\n", messages[0]["content"])
            return {"choices": [{"message": {"content": "yes"}}]}

        result = filter_relevant(
            {"src/app.min.mjs": "bundle", "src/app.js": "source"},
            "Update the helper and its caller.",
            call_llm=call_llm,
            cache=False,
            log=lambda _message: None,
        )
        self.assertEqual(calls["n"], 1)
        skipped = next(row for row in result["decisions"] if row["path"] == "src/app.min.mjs")
        self.assertEqual(skipped["skipped_reason"], "ignored")
        self.assertEqual(skipped["skippedReason"], "ignored")
        self.assertFalse(skipped["relevant"])


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


class ParityFixtureTests(unittest.TestCase):
    FIXTURE_SHA256 = "6976ad71714be0138a6043d9bdeb724abe34a65515f8389913dca10a0c48c4f2"

    @classmethod
    def setUpClass(cls):
        cls.raw = (HERE / "fixtures" / "parity" / "relevance.json").read_bytes()
        cls.fixture = json.loads(cls.raw.decode("utf-8"))

    def test_sha256(self):
        self.assertEqual(hashlib.sha256(self.raw).hexdigest(), self.FIXTURE_SHA256)

    def test_tokens_parser_ignore_and_keys(self):
        from filter_relevant import DEFAULT_IGNORE_PATTERNS

        fixture = self.fixture
        self.assertEqual(FILTER_PROMPT_VERSION, fixture["promptVersion"])
        self.assertEqual(DEFAULT_FILTER_MAX_OUTPUT_TOKENS, fixture["maxOutputTokens"])
        self.assertEqual(DEFAULT_FILTER_REASONING_EFFORT, fixture["reasoningEffort"])
        self.assertEqual(fixture["tokenEstimate"]["rule"], "ceil(code_points/4)")
        self.assertEqual(count_tokens(""), fixture["tokenEstimate"]["empty"])
        for example in fixture["tokenEstimate"]["examples"]:
            self.assertEqual(count_tokens(example["text"]), example["tokens"], example["text"])
        for row in fixture["tokenTruncation"]:
            got = truncate_text(row["text"], None, row["maxTokens"])
            self.assertEqual(got, row["expected"], row["text"])
            self.assertNotIn("\ufffd", got)
        for row in fixture["truncation"]:
            got = truncate_utf8(row["text"], row["maxBytes"])
            self.assertEqual(got, row["expected"], row["text"])
            self.assertNotIn("\ufffd", got)
        for row in fixture["parser"]:
            parsed = parse_yes_no(row["raw"])
            decision = "yes" if parsed is True else "no" if parsed is False else None
            self.assertEqual(decision, row["decision"], row["raw"])
        self.assertTrue(fixture["malformedIsFailedOpen"])
        self.assertEqual(fixture["ignore"]["label"], "ignored")
        self.assertEqual(list(DEFAULT_IGNORE_PATTERNS), fixture["ignore"]["patterns"])
        for example in fixture["ignore"]["examples"]:
            self.assertEqual(is_ignored_path(example["path"]), example["ignored"], example["path"])
        for row in fixture["binary"]["cases"]:
            raw = b"a" * row["pad"] + bytes(row["tail"])
            self.assertEqual(is_binary_content(raw), row["binary"], row["name"])
        bom = fixture["bom"]
        bom_bytes = bytes(bom["bytes"])
        self.assertEqual(decode_utf8_bytes(bom_bytes), bom["text"])
        self.assertFalse(is_binary_content(bom_bytes))
        self.assertEqual(count_tokens(bom["text"]), bom["tokens"])
        self.assertEqual(truncate_text(bom["text"], None, bom["maxTokens"]), bom["truncated"])
        self.assertEqual(
            fixture["cacheKey"]["fields"],
            [
                "prompt_version",
                "model",
                "max_output_tokens",
                "effort_sent",
                "task",
                "path",
                "mode",
                "note",
                "content",
            ],
        )
        for vector in fixture["cacheKey"]["vectors"]:
            key = make_cache_key(
                model=vector["model"],
                task=vector["task"],
                path=vector["path"],
                content=vector["content"],
                max_output_tokens=vector["max_output_tokens"],
                reasoning_effort=vector["effort_sent"],
                prompt_version=vector["prompt_version"],
                mode=vector["mode"],
                note=vector["note"],
            )
            encoded = encode_cache_key([
                str(vector["prompt_version"]),
                str(vector["model"]),
                str(vector["max_output_tokens"]),
                "" if vector["effort_sent"] is None else str(vector["effort_sent"]),
                str(vector["task"]),
                str(vector["path"]),
                str(vector["mode"]),
                "" if vector["note"] is None else str(vector["note"]),
                str(vector["content"]),
            ])
            self.assertEqual(hashlib.sha256(encoded).hexdigest(), vector["sha256"], vector["mode"])
            self.assertEqual(key, vector["sha256"], f"{vector['path']} {vector['mode']}")
        full = next(vector for vector in fixture["cacheKey"]["vectors"] if vector["mode"] == "full" and vector["content"] == "abc")
        cut = next(vector for vector in fixture["cacheKey"]["vectors"] if vector["mode"] == "truncated" and vector["content"] == "abc")
        self.assertNotEqual(full["sha256"], cut["sha256"])

    def test_filter_runs_the_fixture(self):
        fixture = self.fixture

        for row in fixture["tokenTruncation"]:
            seen = {}

            def call_llm(api_key, base_url, model, messages, max_tokens, temperature, reasoning_effort=None, seen=seen):
                seen["body"] = messages[0]["content"].split("File contents:\n", 1)[1]
                return {"choices": [{"message": {"content": "no"}}]}

            filter_relevant(
                {"a.py": row["text"]},
                "task",
                call_llm=call_llm,
                cache=False,
                max_bytes=None,
                max_tokens=row["maxTokens"],
                log=lambda _message: None,
            )
            self.assertEqual(seen["body"], row["expected"], row["text"])
        for row in fixture["truncation"]:
            seen = {}

            def call_llm(api_key, base_url, model, messages, max_tokens, temperature, reasoning_effort=None, seen=seen):
                seen["body"] = messages[0]["content"].split("File contents:\n", 1)[1]
                return {"choices": [{"message": {"content": "no"}}]}

            filter_relevant(
                {"a.py": row["text"]},
                "task",
                call_llm=call_llm,
                cache=False,
                max_bytes=row["maxBytes"],
                max_tokens=None,
                log=lambda _message: None,
            )
            self.assertEqual(seen["body"], row["expected"], row["text"])

        seen = []
        calls = {"n": 0}
        cache = MemoryCache()

        def call_llm(api_key, base_url, model, messages, max_tokens, temperature, reasoning_effort=None):
            calls["n"] += 1
            seen.append(messages[0]["content"])
            return {"choices": [{"message": {"content": "yes"}}]}

        opts = {"call_llm": call_llm, "cache": cache, "log": lambda _message: None, "max_bytes": None, "max_tokens": None}
        encoded = fixture["bytes"]["validUtf8"].encode("utf-8")
        first = filter_relevant({"a.py": encoded}, "task", **opts)
        self.assertEqual(first["files"]["a.py"], fixture["bytes"]["validUtf8"])
        self.assertEqual(first["relevant"]["a.py"], fixture["bytes"]["validUtf8"])
        self.assertNotEqual(first["files"]["a.py"], "")
        self.assertIsNone(first["decisions"][0]["skipped_reason"])
        self.assertIn(fixture["bytes"]["validUtf8"], seen[0])
        left, right = fixture["bytes"]["changed"]
        filter_relevant({"a.py": left.encode("utf-8")}, "task", **opts)
        filter_relevant({"a.py": right.encode("utf-8")}, "task", **opts)
        self.assertEqual(calls["n"], 3)
        invalid = filter_relevant({"a.py": bytes([0xFF])}, "task", **opts)
        self.assertEqual(invalid["decisions"][0]["skipped_reason"], "binary")
        self.assertEqual(invalid["decisions"][0]["skippedReason"], "binary")
        self.assertEqual(invalid["decisions"][0]["decision"], "no")
        self.assertEqual(calls["n"], 3)
        bom_seen = {}

        def bom_llm(api_key, base_url, model, messages, max_tokens, temperature, reasoning_effort=None):
            bom_seen["body"] = messages[0]["content"]
            return {"choices": [{"message": {"content": "yes"}}]}

        bom_file = filter_relevant(
            {"a.py": bytes(fixture["bom"]["bytes"])},
            "task",
            call_llm=bom_llm,
            cache=False,
            log=lambda _message: None,
            max_bytes=None,
            max_tokens=None,
        )
        self.assertIn(fixture["bom"]["text"], bom_seen["body"])
        self.assertEqual(bom_file["relevant"]["a.py"], fixture["bom"]["text"])

        ignored_calls = {"n": 0}

        def ignored_llm(api_key, base_url, model, messages, max_tokens, temperature, reasoning_effort=None):
            ignored_calls["n"] += 1
            return {"choices": [{"message": {"content": "yes"}}]}

        ignored = filter_relevant(
            {"src/app.min.mjs": "var a=1;\n", "src/app.js": "export const a = 1;\n"},
            "task",
            call_llm=ignored_llm,
            cache=False,
            log=lambda _message: None,
        )
        skipped = next(row for row in ignored["decisions"] if row["path"] == "src/app.min.mjs")
        self.assertEqual(skipped["decision"], "no")
        self.assertEqual(skipped["skipped_reason"], fixture["ignore"]["label"])
        self.assertEqual(skipped["skippedReason"], fixture["ignore"]["label"])
        self.assertEqual(ignored_calls["n"], 1)

        malformed = {"n": 0}
        malformed_cache = MemoryCache()

        def malformed_llm(api_key, base_url, model, messages, max_tokens, temperature, reasoning_effort=None):
            malformed["n"] += 1
            return {"choices": [{"message": {"content": "There is no doubt this file is required"}}]}

        open_first = filter_relevant(
            {"src/target.py": "x = 1\n"},
            "edit the target",
            call_llm=malformed_llm,
            cache=malformed_cache,
            log=lambda _message: None,
        )
        open_second = filter_relevant(
            {"src/target.py": "x = 1\n"},
            "edit the target",
            call_llm=malformed_llm,
            cache=malformed_cache,
            log=lambda _message: None,
        )
        self.assertEqual(malformed["n"], 2)
        self.assertEqual(open_first["decisions"][0]["decision"], "yes")
        self.assertTrue(open_first["decisions"][0]["failed_open"])
        self.assertEqual(open_first["failed_open"], 1)
        self.assertFalse(open_second["decisions"][0]["cached"])


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
