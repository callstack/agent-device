// Everything the manifest cannot derive, in one file.
//
// Every entry fails loudly in BOTH directions: adding one that is wrong is caught by the
// assertion it feeds, and deleting one that is load-bearing unowns whatever it covered.
// An entry that stops mattering is reported as inert rather than left to accumulate.

/**
 * Wrappers that spawn a test runner themselves, so their script body names no
 * project. Declaring the units is what lets the CI Coverage lane cover the unit
 * suite; delete this and `unit` reports unowned, which is the failure direction
 * a declaration should have.
 */
export const OPAQUE_RUNNERS: Readonly<Record<string, readonly string[]>> = {
  // `contention-retry-run.ts --coverage` runs Vitest once over every project and
  // reruns only contention-shaped failures (#1419). `--project` defaults to all.
  'test:coverage:ci': [
    'vitest:unit-core',
    'vitest:subprocess-stub',
    'vitest:provider-integration',
    'vitest:interaction-contract',
    'vitest:output-economy',
  ],
};

/**
 * Local actions that run exactly one registered gate, and the input naming it.
 *
 * The seam this replaces took a COMMAND (`build-command: pnpm gate swift-runner-ios`), so
 * a reader had to check every call site to know what the action ran. Taking an id instead
 * makes the value data the audit can validate: the action runs `pnpm gate "$INPUT_GATE"`,
 * `gateIds` checks the id against the registry, and `gateActionBodies` proves the body
 * really is that invocation rather than trusting this list.
 */
export const GATE_ACTIONS: Readonly<Record<string, string>> = {
  '.github/actions/setup-apple-runner-build/action.yml': 'gate',
};

/**
 * What an `if:` on a gate step means for ownership, declared per exact condition.
 *
 * A lane earns credit for `pnpm gate x` because that step RUNS, and a conditional step may
 * not. Undeclared means no credit, so `if: false` — or any other condition nobody has ruled
 * on — unowns whatever it guarded, which is the loud direction. `credits: false` says the
 * same thing deliberately, for conditions that exist and should not count.
 */
export type GateCondition = { readonly credits: boolean; readonly reason: string };

export const GATE_CONDITIONS: Readonly<Record<string, GateCondition>> = {
  'always()': {
    credits: true,
    reason: 'runs whatever the lane did before it; that is the whole meaning of the function',
  },
  "always() && github.event_name == 'pull_request'": {
    credits: true,
    reason:
      'a lane qualifies by being triggered by `pull_request`, and this runs on exactly that ' +
      'event, so the check runs on every PR the manifest reasons about',
  },
  "steps.restore-runner-build.outputs.cache-hit != 'true'": {
    credits: true,
    reason:
      'the Apple runner build. Its cache key is a content hash of everything the gate ' +
      'compiles — `apple/runner/**`, the build script, the runner sources, the action file ' +
      'itself, package.json and the lockfile — so a hit means this exact gate already ' +
      'succeeded on this exact input and its output is what is restored. A miss runs it. ' +
      'The claim is that skipping is equivalent, not that the step always executes.',
  },
  "inputs.package-helpers == 'true' && steps.android-helpers-cache.outputs.cache-hit != 'true'": {
    credits: true,
    reason:
      'the Android helper packaging gate, content-keyed like the Apple build above. The ' +
      'extra conjunct is a caller opt-in: a lane passing `package-helpers: false` does not ' +
      'run it, and this declaration does not evaluate that value. Ownership therefore rests ' +
      'on the three lanes that pass `true`, and would need revisiting if they stopped.',
  },
  'failure()': {
    credits: false,
    reason:
      'the mutation lanes’ envelope recorders, which run only after the lane has already ' +
      'failed and end in `|| true`. Real error-path steps, but a check owned only by one ' +
      'would never run on a green PR. Denying credit costs nothing today: every id they ' +
      'name is also invoked unconditionally in the same workflow.',
  },
  "env.IOS_UDID != ''": {
    credits: false,
    reason:
      'the physical-device replay suite, which runs only when the `IOS_UDID` repository ' +
      'variable names an attached device. Nothing in this tree says whether it is set, so ' +
      'ownership of `replay-ios-device` cannot be proved from the tree and is declared as a ' +
      'known gap below rather than assumed.',
  },
};

/**
 * Checks no lane can be PROVEN to run, with the reason ownership is unprovable rather than
 * absent. Distinct from a waiver: nothing here is excused from needing an owner, it is
 * recorded that the owner exists outside what the tree can show.
 *
 * Fails in both directions like the rest: an entry whose check turns out to be owned by a
 * qualifying lane is inert and must be deleted.
 */
export const UNPROVABLE_OWNERS: Readonly<Record<string, string>> = {
  'replay-ios-device': [
    "Replay Nightly / iOS Replay Suite runs it, guarded by `env.IOS_UDID != ''`.",
    'Whether that repository variable is set is configuration this tree cannot read, so the',
    'lane is wired but the run is not provable here. Tracking: #1429.',
  ].join(' '),
};
