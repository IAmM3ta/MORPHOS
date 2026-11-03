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


# --- CI workflow guard (added 2026-11-02) -----------------------------------
# .github/workflows/ci.yml runs the root pytest without torch and the
# Morphogen v2 npm checks. These cases keep the workflow honest: if someone
# drops a step, or starts installing requirements.txt (which would pull torch
# and turn a seconds-long job into a multi-GB download), this fails locally
# before the push. Plain text checks so the suite stays stdlib-only (no PyYAML).

CI_PATH = os.path.join(ROOT, ".github", "workflows", "ci.yml")


def _ci():
    assert os.path.isfile(CI_PATH), ".github/workflows/ci.yml missing"
    with open(CI_PATH, encoding="utf-8") as fh:
        return "\n".join(_code_lines(fh.read()))


def test_ci_runs_root_pytest_without_torch():
    ci = _ci()
    assert re.search(r"run:\s*pytest\b", ci), "CI must run a bare root pytest"
    assert "requirements.txt" not in ci, "CI python job should not install requirements.txt (pulls torch)"
    assert not re.search(r"pip install[^\n]*\btorch", ci), "CI python job should stay torch-free"


@pytest.mark.parametrize(
    "step",
    ["npm ci", "npm test", "tsc --noEmit", "npm run check:nowebgl"],
)
def test_ci_runs_morphogen_checks(step):
    ci = _ci()
    assert step in ci, f"CI node job is missing `{step}`"
    assert "working-directory: morphogen-v2" in ci


def test_ci_npm_scripts_it_calls_exist():
    import json

    with open(os.path.join(ROOT, "morphogen-v2", "package.json"), encoding="utf-8") as fh:
        scripts = json.load(fh)["scripts"]
    for name in ("test", "check:nowebgl"):
        assert name in scripts, f"package.json lost the `{name}` script CI calls"


# --- scripts/ci_local.sh mirrors the workflow (added 2026-11-03) ------------
#
# The local runner is only useful if "green locally" still means "green on
# GitHub". These checks fail if a CI step is added to or dropped from one file
# but not the other.

CI_LOCAL_PATH = os.path.join(ROOT, "scripts", "ci_local.sh")
CI_STEPS = ("npm ci", "npm test", "tsc --noEmit", "npm run check:nowebgl")


def _ci_local():
    assert os.path.isfile(CI_LOCAL_PATH), "scripts/ci_local.sh missing"
    with open(CI_LOCAL_PATH, encoding="utf-8") as fh:
        return "\n".join(_code_lines(fh.read()))


def test_ci_local_is_executable_bash_with_strict_mode():
    with open(CI_LOCAL_PATH, encoding="utf-8") as fh:
        first = fh.readline().strip()
    assert first == "#!/usr/bin/env bash"
    assert os.access(CI_LOCAL_PATH, os.X_OK), "scripts/ci_local.sh lost its +x bit"
    assert "set -euo pipefail" in _ci_local()


@pytest.mark.parametrize("step", CI_STEPS)
def test_ci_local_runs_every_node_step_ci_runs(step):
    assert step in _ci(), f"workflow no longer runs `{step}`; update CI_STEPS"
    assert step in _ci_local(), f"scripts/ci_local.sh is missing CI step `{step}`"


def test_ci_local_runs_same_pytest_invocation_as_ci():
    m = re.search(r"run:\s*(pytest[^\n]*)", _ci())
    assert m, "CI must run a bare root pytest"
    args = m.group(1).split()[1:]  # e.g. ["-q", "-rs"]
    assert '"$PYTEST" ' + " ".join(args) in _ci_local()
    assert "morphogen-v2" in _ci_local()
    assert not re.search(r"pip install", _ci_local()), "ci_local.sh must not install into the caller's Python"
