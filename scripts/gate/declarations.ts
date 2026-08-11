// Everything the manifest cannot derive, in one file.
//
// The list this replaces (#1714's `GATE_RUNNERS`) had the wrong polarity: deleting
// an entry made the gate *quieter*, because the suite it declared simply left the
// universe. Every entry here fails loudly in both directions instead —
//
//   adding an unlisted one    audit.ts `bypass` fails: a qualifying lane runs
//                             project code that is neither a registered gate nor
//                             declared below;
//   deleting a listed one     audit.ts `inert` fails: the declaration no longer
//                             matches a live step, or removing it no longer
//                             changes the audit.
//
// So a gate cannot be added outside the registry, and a declared step cannot be
// deleted unnoticed. That is the property the derived pressure was there to buy.

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
 * Project code a qualifying lane runs outside the runner. Two shapes, both checked
 * for liveness so a deleted step takes its declaration down with it:
 *
 *   script  a package script that gates nothing — setup, cleanup, measurement.
 *           Scoped to one workflow when only that context justifies it.
 *   step    a command with no package script behind it, named by its step.
 *           Must match exactly one live step: zero means it was renamed or deleted,
 *           more than one means it spread past what was reviewed.
 */
export type Unrouted =
  | {
      readonly kind: 'script';
      readonly script: string;
      readonly workflow?: string;
      readonly reason: string;
    }
  | {
      readonly kind: 'step';
      readonly workflow: string;
      readonly step: string;
      readonly reason: string;
    };

const script = (name: string, reason: string, workflow?: string): Unrouted =>
  workflow
    ? { kind: 'script', script: name, workflow, reason }
    : { kind: 'script', script: name, reason };

const step = (workflow: string, name: string, reason: string): Unrouted => ({
  kind: 'step',
  workflow,
  step: name,
  reason,
});

// The device lanes drive the built CLI against a real simulator, emulator or attached
// device. There is no package script behind these: the flags (`--udid`, `--serial`,
// `--artifacts-dir`) come from the lane's own runtime state. One shared reason rather
// than eight copies of it — what differs between them is only which lane and step.
const DEVICE_REASON = 'drives the built CLI against live hardware';

const DEVICE_STEPS: readonly (readonly [workflow: string, step: string])[] = [
  ['android.yml', 'Run Android smoke checks'],
  ['ios.yml', 'Preflight iOS runner through public CLI'],
  ['ios.yml', 'Run iOS Settings replay smoke test'],
  ['ios.yml', 'Run iOS physical device smoke replay'],
  ['perf-nightly.yml', 'Preflight iOS runner through public CLI'],
  ['replays-nightly.yml', 'Run Android full emulator suite'],
  ['replays-nightly.yml', 'Preflight iOS runner through public CLI'],
  ['replays-nightly.yml', 'Prove selector drag reaches its destination on iOS'],
];

export const UNROUTED: readonly Unrouted[] = [
  script('clean:daemon', 'stops a stray daemon between device runs; asserts nothing'),
  script('test-app:install', "installs the Expo fixture app's own dependency graph"),
  script(
    'perf',
    'writes benchmark reports and exits non-zero only on a crash — a measurement lane, not a gate',
  ),
  script('size', 'measures and comments bundle size; the report is advisory'),
  script('build', 'runs at the PR base commit, where `pnpm gate` need not exist yet', 'size.yml'),

  ...DEVICE_STEPS.map(([workflow, name]) => step(workflow, name, DEVICE_REASON)),

  // Found by the token scan, which reports a command that NAMES runnable repo code
  // rather than one that provably runs it. Over-reporting into this inventory is the
  // intended direction: the alternative is a position parser that stays silent.
  step(
    'size.yml',
    'Preserve report script',
    'copies the report script out of the tree; does not run it',
  ),
  step(
    'linux.yml',
    'Verify environment',
    "prints an AT-SPI tree dump for diagnostics, behind the step's own `|| echo` fallback",
  ),
];
