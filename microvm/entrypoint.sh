#!/bin/bash
set -euo pipefail

if [ -z "${ENCODED_JIT_CONFIG:-}" ]; then
  echo "Error: ENCODED_JIT_CONFIG is required (generate via POST /orgs/{org}/actions/runners/generate-jitconfig)" >&2
  exit 1
fi

# The Docker daemon is started by app.js before the /ready hook, so it is captured warm in the
# MicroVM snapshot and restored pre-warmed on each run (see microvm/app.js). Nothing to start here.
exec ./run.sh --jitconfig "$ENCODED_JIT_CONFIG"
