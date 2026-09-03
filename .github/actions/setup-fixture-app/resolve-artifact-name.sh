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

FINGERPRINT_BIN="examples/test-app/node_modules/.bin/fingerprint"
if [ ! -x "$FINGERPRINT_BIN" ]; then
  echo "fingerprint binary is missing; run the test-app dependency setup first" >&2
  exit 1
fi

# @expo/fingerprint treats process.cwd() as the project root.
FINGERPRINT_ABS="$(cd "$(dirname "$FINGERPRINT_BIN")" && pwd)/$(basename "$FINGERPRINT_BIN")"
FINGERPRINT_JSON="$(cd examples/test-app && "$FINGERPRINT_ABS" fingerprint:generate --platform "$PLATFORM")"
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
