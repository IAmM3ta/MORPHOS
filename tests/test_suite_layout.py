"""Guards for how the root pytest run is laid out (added 2026-11-01).

Background: until 2026-11-01 a bare `pytest` at the repo root stopped with two
collection errors on any machine without torch (e.g. a TouchDesigner-only
box), because test_shapes.py and test_train_sketch.py did `import torch` at
module level. That hid the TD suites behind an "Interrupted" banner and forced
people to run them file by file.

These tests are dependency-free (stdlib only) so they always run, and they fail
if someone reintroduces a hard torch import or drops the root config.
"""

import configparser
import os
import re

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TESTS = os.path.join(ROOT, "tests")

# Modules whose only reason to exist is code that needs torch.
TORCH_SUITES = ("test_shapes.py", "test_train_sketch.py")


def _read(name):
    with open(os.path.join(TESTS, name), encoding="utf-8") as fh:
        return fh.read()


def _code_lines(src):
    """Non-comment, non-blank lines, so commented examples don't count."""
    return [ln for ln in src.splitlines() if ln.strip() and not ln.lstrip().startswith("#")]


def test_root_pytest_ini_scopes_collection_and_path():
    cfg = configparser.ConfigParser()
    assert cfg.read(os.path.join(ROOT, "pytest.ini")), "pytest.ini missing at repo root"
    assert cfg.get("pytest", "testpaths").split() == ["tests"]
    assert "." in cfg.get("pytest", "pythonpath").split()


@pytest.mark.parametrize("name", TORCH_SUITES)
def test_torch_suites_skip_instead_of_erroring(name):
    lines = _code_lines(_read(name))
    skip_idx = next(
        (i for i, ln in enumerate(lines) if re.search(r'importorskip\(\s*"torch"', ln)), None
    )
    assert skip_idx is not None, f"{name} must call pytest.importorskip('torch')"
    # Anything that pulls in torch (directly or via the codec modules) must come after the skip.
    hard = re.compile(r"^\s*(import torch\b|from torch\b|from (generative_codec|bottleneck_train_sketch) import)")
    early = [ln for ln in lines[:skip_idx] if hard.match(ln)]
    assert not early, f"{name} imports torch-dependent code before importorskip: {early}"


def test_torch_free_suites_do_not_import_torch_at_top_level():
    for name in sorted(os.listdir(TESTS)):
        if not (name.startswith("test_") and name.endswith(".py")) or name in TORCH_SUITES:
            continue
        top = [ln for ln in _code_lines(_read(name)) if not ln.startswith((" ", "\t"))]
        bad = [ln for ln in top if re.match(r"(import torch\b|from torch\b)", ln)]
        assert not bad, f"{name} is meant to run without torch but imports it: {bad}"
