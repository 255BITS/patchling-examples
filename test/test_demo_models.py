"""Check walkthrough provider options without importing a paid inference client."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

source = Path(__file__).resolve().parents[1] / "relevance" / "example.py"
spec = importlib.util.spec_from_file_location("demo_example", source)
example = importlib.util.module_from_spec(spec)
spec.loader.exec_module(example)


class DemoModelOptions(unittest.TestCase):
    def test_walkthrough_disables_mimo_thinking_but_preserves_custom_model_options(self):
        provider = SimpleNamespace(
            resolve_api_key=lambda: "test-key",
            resolve_base_url=lambda: "https://nano-gpt.com/api/v1/",
        )
        for model in [example.CHEAP_MODEL, "my/custom-model"]:
            with self.subTest(model=model), patch.dict("sys.modules", {"patchling": provider}), patch.object(
                example, "filter_relevant", return_value={"relevant": {}, "decisions": []}
            ) as classifier:
                example.live_filter({"a.py": "a = 1"}, "edit a", model)
                options = classifier.call_args.kwargs
                self.assertEqual(options["model"], model)
                if model == example.CHEAP_MODEL:
                    self.assertEqual(options["reasoning_effort"], "none")
                else:
                    self.assertNotIn("reasoning_effort", options)


if __name__ == "__main__":
    unittest.main()
