#!/bin/sh
# Regression tests for setup-fixture-app's trusted artifact selection and
# cache-outage fallback.
#
# The fetch step runs under `set -euo pipefail`, so an unhandled API error would
# exit the whole composite — turning a cache-service blip into a conformance
# failure, the opposite of what the action promises. This invokes the shared
# fetch helper itself, points its real API client at an unavailable endpoint,
# and asserts each platform still reaches
# `source=build` and exits 0.
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
ACTION_PATH="$ROOT/.github/actions/setup-fixture-app"
WORK="$(mktemp -d)"
export WORK
trap 'rm -rf "$WORK"' EXIT

pnpm test:fixture-cache

export TEST_WAIT_SECONDS=0

# pnpm yields a fixed fingerprint so the step has a name to look up without
# installing the app. The real selector uses the deliberately unavailable API.
mkdir -p "$WORK/bin"
REAL_NODE="$(command -v node)"
export REAL_NODE
cat > "$WORK/bin/pnpm" <<'STUB'
#!/bin/sh
printf '%s\n' "$*" >> "$WORK/fingerprint-calls"
echo '{"hash":"deadbeefcafe"}'
STUB
cat > "$WORK/bin/node" <<'STUB'
#!/bin/sh
printf '%s\n' "$*" >> "$WORK/node-calls"
exec "$REAL_NODE" "$@"
STUB
chmod +x "$WORK/bin/pnpm" "$WORK/bin/node"

GITHUB_OUTPUT="$WORK/out"
: > "$GITHUB_OUTPUT"
export GITHUB_OUTPUT
GITHUB_ACTION_PATH="$ACTION_PATH"
GITHUB_API_URL="http://127.0.0.1:1"
GH_TOKEN="test-token"
export GITHUB_ACTION_PATH GITHUB_API_URL GH_TOKEN

FAIL=0
run_lookup_outage() {
  PLATFORM="$1"
  : > "$GITHUB_OUTPUT"
  set +e
  PATH="$WORK/bin:$PATH" bash "$ACTION_PATH/fetch-artifact.sh" \
    "$PLATFORM" "$WORK/fixture" "$TEST_WAIT_SECONDS" octo/repo current-head "$ACTION_PATH" \
    > "$WORK/log-outage-$PLATFORM" 2>&1
  RC=$?
  set -e

  echo "--- $PLATFORM fetch step output ---"
  sed 's/^/  /' "$WORK/log-outage-$PLATFORM"
  echo "--- exit code: $RC ---"
  if [ "$RC" -ne 0 ]; then
    echo "FAIL: $PLATFORM lookup outage exited the step (rc=$RC) instead of falling back." >&2
    FAIL=1
  fi
  if ! grep -q '^source=build$' "$GITHUB_OUTPUT"; then
    echo "FAIL: $PLATFORM expected source=build after a lookup failure; got: $(cat "$GITHUB_OUTPUT")" >&2
    FAIL=1
  fi
  if ! grep -q "building inline" "$WORK/log-outage-$PLATFORM"; then
    echo "FAIL: $PLATFORM expected a warning that it is building inline." >&2
    FAIL=1
  fi
  if ! grep -qx -- "--dir examples/test-app exec fingerprint fingerprint:generate --platform $PLATFORM" "$WORK/fingerprint-calls"; then
    echo "FAIL: fixture consumer did not request the $PLATFORM-scoped fingerprint." >&2
    FAIL=1
  fi
  if ! grep -q -- " find octo/repo fingerprint.deadbeefcafe.$PLATFORM current-head$" "$WORK/node-calls"; then
    echo "FAIL: fixture consumer did not query the exact $PLATFORM artifact name." >&2
    FAIL=1
  fi
}

run_lookup_outage ios
run_lookup_outage android

if [ "$FAIL" -eq 0 ]; then
  echo "PASS: platform-scoped build-cache lookup failures degrade to inline builds."
fi

# Exercise the composite's real wait loop without sleeping. The selector's
# provenance and state classification are tested above; these stubs constrain
# only its output so this test can prove each terminal state reaches fallback.
cat > "$WORK/bin/node" <<'STUB'
#!/bin/sh
case "${2:-}" in
  find)
    exit 0
    ;;
  producer-state)
    printf '%s' "$TEST_PRODUCER_STATE"
    exit 0
    ;;
esac
exit 2
STUB
cat > "$WORK/bin/sleep" <<'STUB'
#!/bin/sh
exit 0
STUB
chmod +x "$WORK/bin/node" "$WORK/bin/sleep"

run_terminal_producer_case() {
  TEST_PRODUCER_STATE="$1"
  EXPECTED_LOG="$2"
  PLATFORM="$3"
  export TEST_PRODUCER_STATE EXPECTED_LOG PLATFORM
  TEST_WAIT_SECONDS=1800
  export TEST_WAIT_SECONDS
  : > "$GITHUB_OUTPUT"
  if ! PATH="$WORK/bin:$PATH" bash "$ACTION_PATH/fetch-artifact.sh" \
    "$PLATFORM" "$WORK/fixture" "$TEST_WAIT_SECONDS" octo/repo current-head "$ACTION_PATH" \
    > "$WORK/log-$TEST_PRODUCER_STATE-$PLATFORM" 2>&1; then
    echo "FAIL: $PLATFORM $TEST_PRODUCER_STATE producer state did not fall back cleanly." >&2
    FAIL=1
    return
  fi
  if ! grep -q '^source=build$' "$GITHUB_OUTPUT"; then
    echo "FAIL: $PLATFORM $TEST_PRODUCER_STATE producer state did not select inline build." >&2
    FAIL=1
  fi
  if ! grep -q "$EXPECTED_LOG" "$WORK/log-$TEST_PRODUCER_STATE-$PLATFORM"; then
    echo "FAIL: $PLATFORM $TEST_PRODUCER_STATE producer state did not explain its bounded exit." >&2
    FAIL=1
  fi
}

for PLATFORM in ios android; do
  run_terminal_producer_case queued 'producer is queued' "$PLATFORM"
  run_terminal_producer_case failed 'producer failed' "$PLATFORM"
  run_terminal_producer_case absent 'No fixture producer appeared' "$PLATFORM"
done

if [ "$FAIL" -eq 0 ]; then
  echo "PASS: queued, failed, and absent producers exit the wait path early."
fi

exit "$FAIL"
