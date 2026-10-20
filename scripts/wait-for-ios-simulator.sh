#!/usr/bin/env bash
set -euo pipefail

UDID="${1:?simulator UDID is required}"
TIMEOUT_SECONDS="${2:?boot timeout is required}"
if [[ ! "$TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  echo 'Boot timeout must be a positive integer' >&2
  exit 1
fi
set +e
perl -e 'alarm shift; exec @ARGV' "$TIMEOUT_SECONDS" xcrun simctl bootstatus "$UDID" -b
BOOTSTATUS_EXIT="$?"
set -e
if [ "$BOOTSTATUS_EXIT" -eq 142 ]; then
  echo "Timed out waiting ${TIMEOUT_SECONDS}s for simulator $UDID to boot" >&2
  xcrun simctl list devices || true
  exit 1
fi
exit "$BOOTSTATUS_EXIT"
