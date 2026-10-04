"""A base revision from before NOOP moved into noop/ still compares against the same files."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import parity_ratchet  # noqa: E402

RELATIVE = "Tools/parity_twin_map.json"


def git(cwd: Path, *arguments: str) -> str:
    return subprocess.check_output(["git", *arguments], cwd=cwd, text=True).strip()


class BaseLayoutTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        top = Path(self.temp.name)
        git(top, "init", "-q")
        git(top, "config", "user.email", "tests@example.invalid")
        git(top, "config", "user.name", "Tests")
        (top / "Tools").mkdir()
        (top / RELATIVE).write_text(json.dumps({"layout": "root"}), encoding="utf-8")
        git(top, "add", ".")
        git(top, "commit", "-qm", "NOOP at the repository root")
        self.before = git(top, "rev-parse", "HEAD")
        (top / "noop").mkdir()
        git(top, "mv", "Tools", "noop/Tools")
        (top / "noop" / RELATIVE).write_text(json.dumps({"layout": "noop"}), encoding="utf-8")
        git(top, "commit", "-qam", "NOOP in noop/")
        self.after = git(top, "rev-parse", "HEAD")
        self.noop = top / "noop"

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_read_base_finds_the_file_in_both_layouts(self) -> None:
        self.assertEqual(parity_ratchet._read_base(self.noop, self.before, RELATIVE), {"layout": "root"})
        self.assertEqual(parity_ratchet._read_base(self.noop, self.after, RELATIVE), {"layout": "noop"})

    def test_base_tree_holds_noop_files_at_its_root_in_both_layouts(self) -> None:
        for base, layout in ((self.before, "root"), (self.after, "noop")):
            with parity_ratchet._base_tree(self.noop, base) as tree:
                self.assertEqual(json.loads((tree / RELATIVE).read_text(encoding="utf-8")), {"layout": layout})


if __name__ == "__main__":
    unittest.main()
