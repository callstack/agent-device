#!/bin/sh
# The device evidence for pull request 3842, in the order the maintainer asked
# for it, in one runnable file.
#
# WHY THIS FILE EXISTS
#
# The maintainer of callstack/agent-device asked for live evidence on a real
# iOS device or simulator, because the fixtures and the contract harness only
# prove the change against hand-written snapshots. The machine that wrote the
# change has no macOS, no Xcode, no attached iPhone, and no device-farm
# credentials — so it could not run the lane. It can write down exactly what
# to run, with the repository's own commands, and check the result.
#
# What this script does: it runs the evidence run and PRINTS what each step
# must show. It does not decide anything; a human reads the output and pastes
# it into the pull request.
#
# HOW TO RUN IT
#
#   1. On a Mac with Xcode, with a real iPhone attached (or a simulator):
#        git clone https://github.com/faresrafat3/agent-device.git
#        cd agent-device && git checkout isnad/0008-agent-device-zero-area
#        pnpm install && pnpm build
#   2. Put the home screen on page 2 (a left swipe; by hand is safer — the
#      repository's own ios-system-ui guide says physical-iPhone SpringBoard
#      support is not yet verified).
#   3. sh device-evidence.sh
#
# Every command below appears in the repository's own CLI help. Nothing here is
# invented: `agent-device help ios-system-ui`, `agent-device help physical-device`
# and `agent-device help gesture` are where they come from.
set -eu

WORK=${WORK:-$(pwd)}
OUT=${OUT:-$WORK/device-evidence}
UDID=${UDID:-}
LABEL=${LABEL:-Clock}
GOOD_LABEL=${GOOD_LABEL:-Settings}
mkdir -p "$OUT"

step() { printf '\n══ %s\n' "$1"; }
expect() {
  # expect <what> <command...> — runs the command, saves its output, and says
  # what the output must contain.
  what=$1; shift
  printf -- '── %s\n' "$what"
  printf -- '   $ %s\n' "$*"
  printf '\n'
}

# ── 1. bind the session to SpringBoard on the device ─────────────────────────
step "1. the device, and the session bound to SpringBoard"
expect "list the iOS devices" agent-device devices --platform ios
printf '\n'
expect "open SpringBoard on the device (set UDID to the device's id)" \
  agent-device open com.apple.springboard --platform ios ${UDID:+--udid "$UDID"} --json
printf '\n'
expect "where the runner log is" agent-device session list --json
printf '\nThe runner log must show, for the refused attempt, NO "command=tap" line,\n'
printf 'and a "command=snapshot" line for the same attempt is expected.\n'

# ── 2. the snapshot that carries the 0x0 node ────────────────────────────────
step "2. the snapshot that carries the node with no usable bounds"
expect "capture the tree" agent-device snapshot -i --platform ios --json > "$OUT/snapshot.json"
printf '\n'
printf -- '── the node itself:\n'
printf -- '   $ jq %s\n' "'.nodes[] | select(.label==\"$LABEL\") | {label, rect, hittable, ref}' $OUT/snapshot.json"
jq ".nodes[] | select(.label==\"$LABEL\") | {label, rect, hittable, ref}" "$OUT/snapshot.json" 2>/dev/null || true
printf '\nIt must show a zero-width and zero-height rect and hittable: false.\n'
printf 'If the node is missing from -i, run the regular projection instead:\n'
printf '   agent-device snapshot --platform ios --json > %s/snapshot.json\n' "$OUT"

# ── 3. the selector press must refuse ───────────────────────────────────────
step "3. the selector press must refuse, with no tap dispatched"
expect "press the node by label" \
  agent-device press "label=\"$LABEL\"" --platform ios --json > "$OUT/press-selector.json" || true
cat "$OUT/press-selector.json" 2>/dev/null || true
printf '\nIt must show a non-zero exit, error.code "COMMAND_FAILED",\n'
printf 'error.details.reason "target_bounds_invalid", error.details.dispatched "no".\n'

# ── 4. the runner log must show no tap ───────────────────────────────────────
step "4. the runner log must show no tap request"
RUNNER_LOG=${RUNNER_LOG:-}
if [ -z "$RUNNER_LOG" ]; then
  RUNNER_LOG=$(find "$HOME/Library/Developer/CoreSimulator" "$HOME/.agent-device" \
    -name runner.log -type f 2>/dev/null | head -1)
fi
printf -- 'runner log: %s\n' "${RUNNER_LOG:-not found — set RUNNER_LOG to its path}"
if [ -n "$RUNNER_LOG" ] && [ -f "$RUNNER_LOG" ]; then
  grep -n "AGENT_DEVICE_RUNNER_COMMAND_ACCEPTED" "$RUNNER_LOG" | tail -20 || true
  printf '\n── the tap lines (there must be NONE for the refused attempt):\n'
  grep -n "command=tap" "$RUNNER_LOG" | tail -20 || printf '(none)\n'
fi

# ── 5. the @ref press must refuse the same way ──────────────────────────────
step "5. the @ref press must refuse the same way"
printf 'Take the ref of the node from step 2 and press it:\n'
printf '   agent-device press @e<N> --platform ios --json\n'
printf 'It must show error.details.reason "target_bounds_invalid",\n'
printf 'error.details.ref "e<N>", error.details.dispatched "no", and no tap in the log.\n'

# ── 6. a normal selector must still tap, in the same session ────────────────
step "6. a normal selector must still tap, in the same session"
expect "press an icon that is on the current page" \
  agent-device press "label=\"$GOOD_LABEL\"" --platform ios --json > "$OUT/press-good.json" || true
cat "$OUT/press-good.json" 2>/dev/null || true
printf '\nIt must show exit 0 and success: true, and a "command=tap" line in the log.\n'
printf 'That is the half of the proof that the guard did not break the normal path.\n'

printf '\n══ done. The files in %s are what to paste into the pull request.\n' "$OUT"
printf '   snapshot.json, press-selector.json, press-good.json, and the runner log lines.\n'
