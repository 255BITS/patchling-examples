import tempfile
import unittest
from pathlib import Path

from ink.config import load_config, notebook_path, save_config


class ConfigTests(unittest.TestCase):
    def test_round_trip_notebook_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "inkrc.json"
            self.assertEqual(load_config(path), {})
            saved = save_config({"notebook": "/tmp/notes.json"}, path)
            self.assertEqual(saved["notebook"], "/tmp/notes.json")
            self.assertEqual(notebook_path(load_config(path)), "/tmp/notes.json")

    def test_missing_file_is_empty(self):
        missing = Path("/tmp/does-not-exist-inkrc-relevance.json")
        if missing.exists():
            missing.unlink()
        self.assertEqual(load_config(missing), {})
        self.assertIsNone(notebook_path({}))


if __name__ == "__main__":
    unittest.main()
