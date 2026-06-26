#!/bin/bash
set -euo pipefail

if [ -z "${ENCODED_JIT_CONFIG:-}" ]; then
  echo "Error: ENCODED_JIT_CONFIG is required (generate via POST /orgs/{org}/actions/runners/generate-jitconfig)" >&2
  exit 1
fi

exec ./run.sh --jitconfig "$ENCODED_JIT_CONFIG"
