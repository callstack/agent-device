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

export const UNROUTED: readonly Unrouted[] = [
  script('clean:daemon', 'stops a stray daemon between device runs; asserts nothing'),
  script('test-app:install', "installs the Expo fixture app's own dependency graph"),
  script(
    'perf',
    'writes benchmark reports and exits non-zero only on a crash — a measurement lane, not a gate',
  ),
  script('size', 'measures and comments bundle size; the report is advisory'),
  script('build', 'runs at the PR base commit, where `pnpm gate` need not exist yet', 'size.yml'),

  // The device lanes drive the built CLI against a real simulator/emulator. There is
  // no package script behind these — the flags (`--udid`, `--serial`, `--artifacts-dir`)
  // are resolved from the lane's own runtime state.
  step('android.yml', 'Run Android smoke checks', 'drives the CLI against the booted emulator'),
  step(
    'ios.yml',
    'Preflight iOS runner through public CLI',
    'prepares the runner on the booted simulator',
  ),
  step(
    'ios.yml',
    'Run iOS Settings replay smoke test',
    'drives the CLI against the booted simulator',
  ),
  step(
    'ios.yml',
    'Run iOS physical device smoke replay',
    'drives the CLI against the attached device',
  ),
  step(
    'perf-nightly.yml',
    'Preflight iOS runner through public CLI',
    'prepares the runner on the booted simulator',
  ),
  step(
    'replays-nightly.yml',
    'Run Android full emulator suite',
    'drives the CLI against the booted emulator',
  ),
  step(
    'replays-nightly.yml',
    'Preflight iOS runner through public CLI',
    'prepares the runner on the booted simulator',
  ),
  step(
    'replays-nightly.yml',
    'Prove selector drag reaches its destination on iOS',
    'drives the CLI against the booted simulator',
  ),
];

/** A representative changed path per selector category, checked for tracked-ness. */
export const PATH_SAMPLES: readonly {
  readonly label: string;
  readonly path: string;
  readonly packageEntryFiles?: readonly string[];
}[] = [
  { label: 'production source', path: 'src/commands/batch/index.ts' },
  { label: 'platform source', path: 'src/platforms/android/adb.ts' },
  { label: 'workspace package source', path: 'packages/kernel/src/errors.ts' },
  { label: 'platform package source', path: 'packages/platform-android/src/index.ts' },
  { label: 'node integration test', path: 'test/integration/smoke-cli.test.ts' },
  {
    label: 'Swift runner source',
    path: 'apple/runner/AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTapPointPolicy.swift',
  },
  {
    label: 'Android helper source',
    path: 'android/snapshot-helper/src/main/java/com/callstack/agentdevice/snapshothelper/AccessibilityTreeCapture.java',
  },
  {
    label: 'macOS helper source',
    path: 'apple/macos-helper/Sources/AgentDeviceMacOSHelper/AudioProbe.swift',
  },
  { label: 'MCP registry metadata', path: 'server.json' },
  { label: 'Expo test app', path: 'examples/test-app/app/(tabs)/audio.tsx' },
  {
    label: 'replay-compat corpus',
    path: 'test/replay-compat/scripts/docs/context-header-conflicting-platform.v0.15.1.ad',
  },
  { label: 'replay-compat fixture', path: 'test/replay-compat/corpus.test.ts' },
  { label: 'daemon wire ledger', path: 'test/wire-compat/surface.ts' },
  // #1420: ci.yml ignores website/**, so the command-reference gate has to be owned
  // by a lane that docs changes actually start. Now that `command-docs` is a real
  // check this is an ordinary category rather than a special case in the checker.
  { label: 'command reference docs', path: 'website/docs/docs/commands.md' },
  {
    label: 'published package entry',
    path: 'src/sdk/index.ts',
    packageEntryFiles: ['src/sdk/index.ts'],
  },
];
