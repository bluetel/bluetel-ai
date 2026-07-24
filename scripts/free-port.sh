#!/usr/bin/env bash
# Kills whatever is listening on the given port and waits until it's free.
# Usage: free-port.sh <port>
set -euo pipefail

port="$1"

if fuser "${port}/tcp" >/dev/null 2>&1; then
  fuser -k "${port}/tcp" >/dev/null 2>&1 || true

  for _ in $(seq 1 50); do
    if ! fuser "${port}/tcp" >/dev/null 2>&1; then
      break
    fi
    sleep 0.1
  done
fi

exit 0
