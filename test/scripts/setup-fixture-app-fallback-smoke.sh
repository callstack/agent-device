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
node -e '
  const fs = require("fs");
  const yaml = require("yaml");
  const doc = yaml.parse(fs.readFileSync(process.argv[1], "utf8"));
  const step = doc.runs.steps.find((s) => s.id === "fetch");
  if (!step) { console.error("no fetch step in action.yml"); process.exit(2); }
  let body = step.run
    .replaceAll("${{ github.repository }}", "octo/repo")
    .replaceAll("${{ github.workspace }}", process.env.WORK);
  fs.writeFileSync(process.env.WORK + "/fetch.sh", body);
' "$ACTION"

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
exit "$FAIL"
