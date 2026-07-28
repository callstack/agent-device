#!/bin/sh
# Regression tests for setup-fixture-app's trusted artifact selection and
# cache-outage fallback.
#
# The fetch step runs under `set -euo pipefail`, so an unhandled API error would
# exit the whole composite — turning a cache-service blip into a conformance
# failure, the opposite of what the action promises. This extracts that step's
# actual shell from action.yml (so it cannot drift from a copy), points its real
# API client at an unavailable endpoint, and asserts it still reaches
# `source=build` and exits 0.
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
ACTION="$ROOT/.github/actions/setup-fixture-app/action.yml"
WORK="$(mktemp -d)"
export WORK
trap 'rm -rf "$WORK"' EXIT

pnpm test:fixture-cache

# Extract the exact `run:` body of the fetch step, then substitute the GitHub
# expressions the composite would have expanded.
extract_fetch() {
  node -e '
    const fs = require("fs");
    const yaml = require("yaml");
    const doc = yaml.parse(fs.readFileSync(process.argv[1], "utf8"));
    const step = doc.runs.steps.find((s) => s.id === "fetch");
    if (!step) { console.error("no fetch step in action.yml"); process.exit(2); }
    let body = step.run
      .replaceAll("${{ github.repository }}", "octo/repo")
      .replaceAll("${{ github.event.pull_request.head.sha || github.sha }}", "current-head")
      .replaceAll("${{ github.workspace }}", process.env.WORK)
      .replaceAll("${{ inputs.wait-for-artifact-seconds }}", process.env.TEST_WAIT_SECONDS);
    fs.writeFileSync(process.env.WORK + "/fetch.sh", body);
  ' "$ACTION"
}

export TEST_WAIT_SECONDS=0
extract_fetch

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
GITHUB_ACTION_PATH="$ROOT/.github/actions/setup-fixture-app"
GITHUB_API_URL="http://127.0.0.1:1"
GH_TOKEN="test-token"
export GITHUB_ACTION_PATH GITHUB_API_URL GH_TOKEN

set +e
PATH="$WORK/bin:$PATH" bash "$WORK/fetch.sh" > "$WORK/log" 2>&1
RC=$?
set -e

echo "--- fetch step output ---"
sed 's/^/  /' "$WORK/log"
echo "--- exit code: $RC ---"

FAIL=0
if [ "$RC" -ne 0 ]; then
  echo "FAIL: a lookup outage exited the step (rc=$RC) instead of falling back." >&2
  FAIL=1
fi
if ! grep -q '^source=build$' "$GITHUB_OUTPUT"; then
  echo "FAIL: expected source=build after a lookup failure; got: $(cat "$GITHUB_OUTPUT")" >&2
  FAIL=1
fi
if ! grep -q "building inline" "$WORK/log"; then
  echo "FAIL: expected a warning that it is building inline." >&2
  FAIL=1
fi
if ! grep -qx -- '--dir examples/test-app exec fingerprint fingerprint:generate --platform ios' "$WORK/fingerprint-calls"; then
  echo "FAIL: fixture consumer did not request the iOS-scoped fingerprint." >&2
  FAIL=1
fi
if ! grep -q -- ' find octo/repo fingerprint.deadbeefcafe.ios current-head$' "$WORK/node-calls"; then
  echo "FAIL: fixture consumer did not query the exact platform-scoped artifact name." >&2
  FAIL=1
fi

if [ "$FAIL" -eq 0 ]; then
  echo "PASS: build-cache lookup failure degrades to an inline build."
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
  export TEST_PRODUCER_STATE EXPECTED_LOG
  TEST_WAIT_SECONDS=1800
  export TEST_WAIT_SECONDS
  extract_fetch
  : > "$GITHUB_OUTPUT"
  if ! PATH="$WORK/bin:$PATH" bash "$WORK/fetch.sh" > "$WORK/log-$TEST_PRODUCER_STATE" 2>&1; then
    echo "FAIL: $TEST_PRODUCER_STATE producer state did not fall back cleanly." >&2
    FAIL=1
    return
  fi
  if ! grep -q '^source=build$' "$GITHUB_OUTPUT"; then
    echo "FAIL: $TEST_PRODUCER_STATE producer state did not select inline build." >&2
    FAIL=1
  fi
  if ! grep -q "$EXPECTED_LOG" "$WORK/log-$TEST_PRODUCER_STATE"; then
    echo "FAIL: $TEST_PRODUCER_STATE producer state did not explain its bounded exit." >&2
    FAIL=1
  fi
}

run_terminal_producer_case queued 'producer is queued'
run_terminal_producer_case failed 'producer failed'
run_terminal_producer_case absent 'No fixture producer appeared'

if [ "$FAIL" -eq 0 ]; then
  echo "PASS: queued, failed, and absent producers exit the wait path early."
fi

exit "$FAIL"
