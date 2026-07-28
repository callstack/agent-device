#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: resolve-artifact-name.sh <ios|android>" >&2
  exit 2
fi

PLATFORM="$1"
case "$PLATFORM" in
  ios|android) ;;
  *)
    echo "usage: resolve-artifact-name.sh <ios|android>" >&2
    exit 2
    ;;
esac

FINGERPRINT_JSON="$(pnpm --dir examples/test-app exec fingerprint fingerprint:generate --platform "$PLATFORM")"
if ! HASH="$(
  printf '%s\n' "$FINGERPRINT_JSON" |
    jq -ser '
      select(length == 1)
      | .[0].hash
      | select(type == "string" and . != "null" and test("\\A[A-Za-z0-9_-]+\\z"))
    '
)"; then
  echo "fingerprint:generate returned an invalid $PLATFORM hash" >&2
  exit 1
fi
printf 'fingerprint.%s.%s\n' "$HASH" "$PLATFORM"
