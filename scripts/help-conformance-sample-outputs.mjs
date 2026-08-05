// Captured agent-device output embedded in benchmark quiz cases. Each sample
// is { command, output }: the command line the prompt claims was run, and the
// exact text the CLI would print for it. Every `output` is pinned to the real
// renderer by scripts/__tests__/help-conformance-sample-outputs.test.ts, which
// rebuilds it through src/commands/interaction/output.ts or
// src/utils/output.ts printHumanError — a rendering change fails that test
// instead of silently leaving the benchmark grading against stale output.

export function sampleText(sample) {
  return `${sample.command}\n${sample.output}`;
}

// Settled press whose diff carried no added ref, so the response appended the
// unchanged-interactive tail (#1167/#1172). The response carried a diff plus
// refsGeneration, so the tail refs render pinned (ADR 0014).
export const SETTLE_TAIL_SAMPLE = {
  command: 'agent-device press @e37 --settle',
  output: `Tapped @e37 (203, 88)
settled after 540ms: +0 -1 (~15 unchanged)
- @e50 [text] "Suggested for you"
unchanged interactive (4):
= @e64~s5 [text-field] "Search"
= @e65~s5 [text] "Recent searches"
= @e12~s5 [tab] "Home"
= @e40~s5 [tab] "Profile"`,
};

// Settled fill whose diff exposes the next target directly.
export const SETTLE_DIFF_SAMPLE = {
  command: `agent-device fill 'id="account-search"' "callstack" --settle`,
  output: `Filled 9 chars
settled after 610ms: +2 -0 (~18 unchanged)
+ @e64 [button] "@callstack.com"
+ @e65 [text] "Callstack"`,
};

// Metamorphic twin of SETTLE_DIFF_SAMPLE on a different app and ref range, so
// a pass cannot come from memorizing the callstack sample.
export const SETTLE_DIFF_SAMPLE_NOTES = {
  command: `agent-device fill 'id="notes-search"' "groceries" --settle`,
  output: `Filled 9 chars
settled after 480ms: +2 -0 (~11 unchanged)
+ @e21 [button] "Groceries list"
+ @e22 [text] "3 items"`,
};

// Never-settled press: success response, no diff, NEVER_SETTLED_HINT attached.
export const NOT_SETTLED_SAMPLE = {
  command: 'agent-device press @e12 --settle',
  output: `Tapped @e12 (166, 240)
not settled after 10000ms
hint: The UI kept changing for the whole settle budget (animation, carousel, or ticker?), so no settled diff is shown. Raise --timeout, wait for specific content, or take a fresh snapshot.`,
};

// Recovered snapshot: the private-ax fallback fired but still exposed
// actionable refs. Warning wording is renderSnapshotQualityWarnings
// (src/snapshot/snapshot-quality.ts); lines are the structured snapshot
// renderer (src/utils/output.ts formatSnapshotText).
export const PRIVATE_AX_RECOVERY_SAMPLE = {
  command: 'agent-device snapshot -i',
  output: `Snapshot: 2 nodes
Detected an overly complex or slow accessibility tree. Fell back to the private-ax snapshot backend. It is OK to continue; use --json to inspect snapshotQuality.reason if you need recovery details.
@e5 [button] "Search"
@e8 [tab] "Home" [selected]`,
};

// DEVICE_IN_USE from buildDeviceInUseBySessionError
// (src/daemon/handlers/session-open.ts) — the parity test drives that exact
// producer.
export const DEVICE_IN_USE_SAMPLE = {
  command: `agent-device press 'label="Place order"' --settle`,
  output: `Error (DEVICE_IN_USE): Device is already in use by session "checkout".
Hint: Run agent-device session list to inspect active sessions. To reuse this device, rerun the command with --session checkout. To open a new session on this device, first run agent-device close --session checkout.`,
};

// ADR 0014 mutation rejection from
// src/daemon/handlers/interaction-ref-policy.ts: a pinned ref minted from a
// superseded generation is rejected before dispatch. The daemon strips the
// `~s5` pin at the boundary (interaction-touch-targets.ts), so the message
// names the plain ref; the hint is the precise resolveRefStalenessWarning.
export const STALE_REF_SAMPLE = {
  command: 'agent-device press @e12~s5 --settle',
  output: `Error (COMMAND_FAILED): Ref @e12 was minted from a superseded snapshot generation
Hint: Ref @e12 was minted from snapshot s5 but the session's ref frame is now s7 — re-run snapshot -i.`,
};

// AMBIGUOUS_MATCH from buildAmbiguousMatchError (src/daemon/handlers/find.ts)
// — the parity test drives that exact producer. The by-design rejection
// instead of silent disambiguation: #1597 made the candidate refs (ref, role,
// label/identifier — the same compact rendering as snapshot -i) print
// unconditionally via formatErrorCandidateLines
// (src/utils/error-candidates.ts), capped at AMBIGUOUS_MATCH_CANDIDATE_LIMIT (5) with a
// "+N more" marker. Here all 3 candidates share the identical "Follow" label,
// so the printed refs still cannot be told apart from this output alone —
// the agent must re-observe or narrow, not guess which @ref is the right row.
export const AMBIGUOUS_MATCH_SAMPLE = {
  command: 'agent-device find text "Follow"',
  output: `Error (AMBIGUOUS_MATCH): find matched 3 elements for text "Follow". Use a more specific locator or selector.
Hint: Multiple candidates matched. Narrow the query or pass an exact identifier.
Candidates:
  @e2 [button] "Follow"
  @e5 [button] "Follow"
  @e9 [button] "Follow"`,
};

// APP_NOT_INSTALLED from buildAppNotInstalledError
// (src/platforms/apple/core/app-resolution.ts) — the parity test drives that
// exact producer; the hint is defaultHintForCode('APP_NOT_INSTALLED').
export const APP_NOT_INSTALLED_SAMPLE = {
  command: 'agent-device open Shoply --platform ios',
  output: `Error (APP_NOT_INSTALLED): No app found matching "Shoply"
Hint: Run apps to discover the exact installed package or bundle id, or install the app before open.`,
};

// Successful BrowserStack connect output from renderConnectSuccess. The
// provider resources are already verified, but allocation remains deferred;
// the next command must use the installed package id instead of probing a
// not-yet-created device with devices/apps.
export const BROWSERSTACK_CONNECT_SAMPLE = {
  command:
    'agent-device connect browserstack --platform android --device "Google Pixel 8" --provider-os-version 14.0 --provider-app bs://app-id',
  output: `Connected successfully with BrowserStack.
Verified: Credentials, device, and uploaded app verified.
Device: Google Pixel 8 (android 14.0) — verified
App: sample.apk — verified
No live device session has been created. The first device command shown below will allocate one.
Next:
  agent-device open <package-id> --relaunch
Use the installed package or bundle identifier in open, not the app artifact name.
After close, run agent-device artifacts --json for provider video and logs.`,
};
