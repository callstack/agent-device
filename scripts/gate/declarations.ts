// The five small facts the manifest cannot derive from package scripts and workflow YAML.

// A script whose Vitest/node-test invocation the loader cannot read, mapped to the units it
// really runs. Empty right now: the one entry was a coverage wrapper, and `test:coverage:ci`
// is back to shapes the loader reads directly. It is no longer a single bare run — it is a
// negated `--project` leg plus a nested script — but scripts/gate/model.ts resolves both, so
// the units still come from the script itself.
export const OPAQUE_RUNNERS: Readonly<Record<string, readonly string[]>> = {};

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

/**
 * A check whose only lane is a `workflow_dispatch` workflow.
 *
 * `lane` is the load-bearing field, not documentation: the audit resolves it against the
 * derived model and fails when the named lane is gone, has become a pull_request/schedule
 * lane again, or has stopped declaring the gate. Without it the record would be a plain
 * allowlist, and deleting the parked job would read as "parked" forever — parked coverage
 * quietly becoming deleted coverage.
 */
export type ManualOnlyOwner = {
  /** Lane label, exactly as the loader builds it: `<workflow name> / <job name>`. */
  readonly lane: string;
  /**
   * Set when the lane's own steps cannot show the gate, so the lane's existence is the whole
   * attestation the model can make. Every opaque entry needs the surface named in `reason`.
   */
  readonly opaque?: true;
  readonly reason: string;
};

// Checks nothing runs on the way in or on a schedule — *unowned by design and temporarily*,
// the opposite of the claim UNPROVABLE_OWNERS makes. `check.ts` prints them by name on every
// run rather than folding them into the wired count, because a check that quietly loses its
// owner reads exactly like a green build. Delete the entry when the lane goes back on
// `pull_request` or `schedule`; the audit fails if an entry outlives its parking, and fails
// the other way too if a declaration is deleted while its lane is still dispatch-only.
export const MANUAL_ONLY_OWNERS: Readonly<Record<string, ManualOnlyOwner>> = {
  'replay-android': {
    lane: 'Replay Manual / Android Full Emulator Suite',
    opaque: true,
    reason: [
      'Parked on `workflow_dispatch` by #1781 A1. The lane runs `pnpm gate replay-android`',
      'inside the `script:` input of `reactivecircus/android-emulator-runner` — shell handed',
      'to a third-party action, which this loader does not read — so the job existing is all',
      'the model can attest, and the gate would be invisible even back on a schedule. Routing',
      'the emulator lane through steps the loader opens is the open item named in #1429.',
    ].join(' '),
  },
  'replay-ios': {
    lane: 'Replay Manual / iOS Replay Suite',
    reason: [
      'Parked on `workflow_dispatch` by #1781 A1 after the suite failed every scheduled run',
      'from 2026-07-24 on.',
    ].join(' '),
  },
  'replay-ios-device': {
    lane: 'Replay Manual / iOS Replay Suite',
    reason: [
      'Parked on `workflow_dispatch` by #1781 A1 with the simulator suite it shares a job',
      'with; the step is additionally skipped unless the `IOS_UDID` repository variable is set.',
    ].join(' '),
  },
};

/**
 * A `pull_request` lane whose `paths-ignore` list is routing, not hygiene (#1781 A9-2): the
 * list is asserted against the affected selector over every tracked path, both ways. A path
 * the selector fails open on, or routes to one of the lane's declared gates or to `sampled`
 * (checks the lane runs a slice of through raw shell, invisible to the loader), must start the
 * lane; a path the selector places on another family's device-lane surface, or classifies as
 * a unit test, must not. GitHub evaluates the list before a runner is allocated, so the
 * decision costs no macOS time and adds no job to the critical path.
 */
export type RoutedLane = {
  /** Lane label, exactly as the loader builds it: `<workflow name> / <job name>`. */
  readonly lane: string;
  /** Checks the lane samples without declaring, in addition to its run-gate declarations. */
  readonly sampled: readonly string[];
};

export const ROUTED_LANES: readonly RoutedLane[] = [
  // ios.yml declares swift-runner-ios; its raw-shell steps run one iOS simulator replay and, when
  // IOS_UDID is set, one physical-device replay — a slice of the parked replay-ios lanes.
  { lane: 'iOS / Smoke Tests', sampled: ['replay-ios', 'replay-ios-device'] },
];
