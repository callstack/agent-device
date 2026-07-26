#!/bin/sh
# Regression test for setup-fixture-app: a build-cache lookup failure must
# degrade to an inline build, never fail the caller.
#
# The fetch step runs under `set -euo pipefail`, so a bare `ART_ID="$(gh api …)"`
# would exit the whole composite on any API outage — turning a cache-service
# blip into a conformance failure, the opposite of what the action promises. This
# extracts that step's actual shell from action.yml (so it cannot drift from a
# copy), runs it with a `gh` that fails the lookup, and asserts it still reaches
# `source=build` and exits 0.
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
ACTION="$ROOT/.github/actions/setup-fixture-app/action.yml"
WORK="$(mktemp -d)"
export WORK
trap 'rm -rf "$WORK"' EXIT

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
      .replaceAll("${{ github.workspace }}", process.env.WORK)
      .replaceAll("${{ inputs.wait-for-artifact-seconds }}", process.env.TEST_WAIT_SECONDS)
      .replaceAll("${{ inputs.producer-workflow }}", process.env.TEST_PRODUCER_WORKFLOW)
      .replaceAll("${{ inputs.producer-head-sha }}", process.env.TEST_PRODUCER_HEAD_SHA);
    fs.writeFileSync(process.env.WORK + "/fetch.sh", body);
  ' "$ACTION"
}

export TEST_WAIT_SECONDS=0
export TEST_PRODUCER_WORKFLOW=
export TEST_PRODUCER_HEAD_SHA=
extract_fetch

# Stubs on PATH: gh fails every call (simulated outage); pnpm yields a fixed
# fingerprint so the step has a name to look up without installing the app.
mkdir -p "$WORK/bin"
cat > "$WORK/bin/gh" <<'STUB'
#!/bin/sh
echo "gh: simulated API outage" >&2
exit 1
STUB
cat > "$WORK/bin/pnpm" <<'STUB'
#!/bin/sh
echo '{"hash":"deadbeefcafe"}'
STUB
chmod +x "$WORK/bin/gh" "$WORK/bin/pnpm"

GITHUB_OUTPUT="$WORK/out"
: > "$GITHUB_OUTPUT"
export GITHUB_OUTPUT

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

if [ "$FAIL" -eq 0 ]; then
  echo "PASS: build-cache lookup failure degrades to an inline build."
fi

# A failed producer must stop a long configured wait rather than burning the
# entire macOS job budget. Stub sleep keeps this contract test instant.
export TEST_WAIT_SECONDS=1800
export TEST_PRODUCER_WORKFLOW=test-app-build-cache.yml
export TEST_PRODUCER_HEAD_SHA=producer-sha
extract_fetch
cat > "$WORK/bin/gh" <<'STUB'
#!/bin/sh
case "$*" in
  *actions/workflows/test-app-build-cache.yml/runs*)
    printf '123\tin_progress\t\n'
    ;;
  *actions/runs/123/jobs*)
    printf 'completed\tfailure\n'
    ;;
  *)
    exit 0
    ;;
esac
STUB
cat > "$WORK/bin/sleep" <<'STUB'
#!/bin/sh
exit 0
STUB
chmod +x "$WORK/bin/gh" "$WORK/bin/sleep"

GITHUB_OUTPUT="$WORK/out-producer"
: > "$GITHUB_OUTPUT"
export GITHUB_OUTPUT
set +e
PATH="$WORK/bin:$PATH" bash "$WORK/fetch.sh" > "$WORK/log-producer" 2>&1
PRODUCER_RC=$?
set -e
if [ "$PRODUCER_RC" -ne 0 ] ||
  ! grep -q "iOS fixture producer job.*completed with failure" "$WORK/log-producer" ||
  ! grep -q '^source=build$' "$GITHUB_OUTPUT"; then
  echo "FAIL: a failed producer did not stop the configured artifact wait." >&2
  sed 's/^/  /' "$WORK/log-producer" >&2
  FAIL=1
else
  echo "PASS: a failed producer stops the artifact wait and builds inline."
fi

# A same-repository PR can miss the producer path filter. Three instant polls
# prove that case takes the bounded grace path instead of the 30-minute wait.
cat > "$WORK/bin/gh" <<'STUB'
#!/bin/sh
exit 0
STUB
chmod +x "$WORK/bin/gh"
GITHUB_OUTPUT="$WORK/out-no-producer"
: > "$GITHUB_OUTPUT"
export GITHUB_OUTPUT
set +e
PATH="$WORK/bin:$PATH" bash "$WORK/fetch.sh" > "$WORK/log-no-producer" 2>&1
NO_PRODUCER_RC=$?
set -e
if [ "$NO_PRODUCER_RC" -ne 0 ] ||
  ! grep -q "No fixture producer appeared" "$WORK/log-no-producer" ||
  ! grep -q '^source=build$' "$GITHUB_OUTPUT"; then
  echo "FAIL: an absent producer did not stop after the scheduling grace polls." >&2
  sed 's/^/  /' "$WORK/log-no-producer" >&2
  FAIL=1
else
  echo "PASS: an absent producer stops after bounded scheduling grace."
fi

exit "$FAIL"
