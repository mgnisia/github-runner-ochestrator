#!/bin/bash
set -euo pipefail

if [ -z "${ENCODED_JIT_CONFIG:-}" ]; then
  echo "Error: ENCODED_JIT_CONFIG is required (generate via POST /orgs/{org}/actions/runners/generate-jitconfig)" >&2
  exit 1
fi

# The Docker daemon is started by app.js before the /ready hook and captured warm in the MicroVM
# snapshot. After restore, app.js bounces (restarts) the daemon in the /run hook before this
# script runs, so BuildKit gets a fresh session socket instead of a snapshot-frozen one.
# Nothing to start or restart here — app.js owns the entire daemon lifecycle.
exec ./run.sh --jitconfig "$ENCODED_JIT_CONFIG"
