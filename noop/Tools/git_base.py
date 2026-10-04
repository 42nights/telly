"""Find NOOP's files at a git revision from before or after NOOP moved into noop/."""

from __future__ import annotations

import subprocess
from pathlib import Path


def base_location(root: Path, rev: str) -> tuple[Path, str]:
    """Return the repository top level and NOOP's path prefix at `rev`.

    The prefix is `noop/` for a revision after the move and empty for a revision before it, so a
    comparison against an older base reads the same NOOP files. Run git with `cwd` at the returned
    top level and put the prefix in front of each NOOP-relative path.
    """

    def git(*arguments: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(["git", *arguments], cwd=root, capture_output=True, text=True)

    top = git("rev-parse", "--show-toplevel")
    if top.returncode != 0:
        return root, ""
    prefix = git("rev-parse", "--show-prefix").stdout.strip()
    if prefix and git("cat-file", "-e", f"{rev}:{prefix}").returncode != 0:
        prefix = ""
    return Path(top.stdout.strip()), prefix


def archive_treeish(rev: str, prefix: str) -> str:
    """The tree-ish to `git archive` (from the top level) for NOOP's files at `rev`."""
    return f"{rev}:{prefix}" if prefix else rev
