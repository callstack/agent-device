// The four small facts the manifest cannot derive from package scripts and workflow YAML.

export const OPAQUE_RUNNERS: Readonly<Record<string, readonly string[]>> = {
  // This wrapper runs Vitest over every project, then retries owned contention failures.
  'test:coverage:ci': [
    'vitest:unit-core',
    'vitest:subprocess-stub',
    'vitest:provider-integration',
    'vitest:interaction-contract',
    'vitest:output-economy',
  ],
};

export const REPORTING_SCRIPTS: Readonly<Record<string, string>> = {
  'test:integration:progress': [
    'Prints the provider-backed integration status table and exits 0. The assertion lives in',
    'its `--check` sibling, `test:integration:progress:check`, which IS the registered',
    '`integration-progress` gate. Running the reporter in CI would gate nothing.',
  ].join(' '),
};

// A check whose lane runs, but through a surface the loader cannot read. Empty right now:
// the one entry moved to MANUAL_ONLY_OWNERS when its lane stopped running automatically.
export const UNPROVABLE_OWNERS: Readonly<Record<string, string>> = {};

// Checks whose only lane is a `workflow_dispatch` workflow. Nothing runs them on the way in or
// on a schedule, so these are *unowned by design and temporarily* — the opposite of the claim
// UNPROVABLE_OWNERS makes. `check.ts` prints them by name on every run rather than folding
// them into the wired count, because a check that quietly loses its owner reads exactly like a
// green build. Delete the entry when the lane goes back on `pull_request` or `schedule`;
// scripts/gate/audit.test.ts fails if an entry here is owned again.
export const MANUAL_ONLY_OWNERS: Readonly<Record<string, string>> = {
  'replay-android': [
    'Replay Manual / Android Full Emulator Suite (`workflow_dispatch` only, #1781 A1) is the',
    'sole lane. It also runs `pnpm gate replay-android` inside the `script:` input of',
    '`reactivecircus/android-emulator-runner`, shell handed to a third-party action that this',
    'loader does not read, so the lane would be invisible even on a schedule — the open item',
    'named in #1429.',
  ].join(' '),
  'replay-ios': [
    'Replay Manual / iOS Replay Suite (`workflow_dispatch` only, #1781 A1) is the sole lane.',
    'It was parked with the Android suite after failing every scheduled run from 2026-07-24.',
  ].join(' '),
  'replay-ios-device': [
    'Replay Manual / iOS Replay Suite (`workflow_dispatch` only, #1781 A1) is the sole lane,',
    'and the step is skipped unless the `IOS_UDID` repository variable is set.',
  ].join(' '),
};
