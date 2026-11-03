#!/usr/bin/env bash
# Run MORPHOS CI locally (added 2026-11-03).
#
# Mirrors .github/workflows/ci.yml step for step, so "green here" means
# "green on GitHub" without waiting for a push:
#
#   python job -> bare `pytest -q -rs` at the repo root. Torch codec suites
#                 skip by design (pytest.importorskip); TD / Sync suites and the
#                 stdlib layout guards run for real.
#   node job   -> in morphogen-v2/: `npm ci`, `npm test`, `npx tsc --noEmit`,
#                 `npm run check:nowebgl` (needs ripgrep / `rg` on PATH).
#
# Usage:
#   scripts/ci_local.sh            # both jobs, python first
#   scripts/ci_local.sh python     # root pytest only
#   scripts/ci_local.sh node       # Morphogen v2 checks only
#   PYTEST=/path/to/pytest scripts/ci_local.sh   # use a venv's pytest
#
# Unlike CI it does NOT install anything into your Python: it expects pytest
# to already be importable (or PYTEST to point at one). `npm ci` does rewrite
# morphogen-v2/node_modules, exactly as on the runner.
#
# tests/test_suite_layout.py checks this script keeps running the same
# commands as the workflow, so the two can't drift apart silently.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
JOB="${1:-all}"
PYTEST="${PYTEST:-pytest}"

run_python() {
  echo "==> [python] pytest -q -rs (repo root)"
  (cd "$ROOT" && "$PYTEST" -q -rs)
}

run_node() {
  command -v rg >/dev/null 2>&1 || {
    echo "ci_local: ripgrep (rg) is required for check:nowebgl" >&2
    exit 1
  }
  echo "==> [node] morphogen-v2: npm ci / npm test / tsc --noEmit / check:nowebgl"
  (
    cd "$ROOT/morphogen-v2"
    npm ci
    npm test
    npx tsc --noEmit
    npm run check:nowebgl
  )
}

case "$JOB" in
  all) run_python; run_node ;;
  python) run_python ;;
  node) run_node ;;
  *) echo "usage: scripts/ci_local.sh [all|python|node]" >&2; exit 2 ;;
esac

echo "==> ci_local: $JOB OK"
