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
 * Every `run:` step in a qualifying lane that is not a `pnpm gate` invocation.
 *
 * This is an inventory, not a waiver list: audit.ts decides by SHAPE, so a step is
 * allowed only because it is `pnpm gate <id>` or because it is written down here.
 * Nothing inspects what a command does — three review rounds showed that question is
 * not answerable from command text (`pnpm exec`, `pnpm exec --`, `npx --yes`,
 * `node -e 'import(…)'`, and after those, `eval`, heredocs and base64).
 *
 * The price is that this list is long and must be kept current. That is the point: it
 * is the complete census of everything CI does outside the runner, reviewable in one
 * place, and it fails in both directions — an unlisted step fails as a bypass, and a
 * listed step that is renamed or deleted fails as inert.
 */
export type Unrouted = {
  readonly workflow: string;
  /** The step's `name:`, matched exactly against a live `run:` step. */
  readonly step: string;
  readonly reason: string;
};

const steps = (workflow: string, reason: string, names: readonly string[]): Unrouted[] =>
  names.map((step) => ({ workflow, step, reason }));

export const NON_GATE_STEPS: readonly Unrouted[] = [
  ...steps(
    '.github/actions/setup-node-pnpm/action.yml',
    'toolchain setup: pins pnpm to packageManager and installs dependencies',
    [
      'Resolve pnpm version from packageManager',
      'Assert pnpm matches packageManager',
      'Install dependencies',
    ],
  ),

  ...steps(
    '.github/actions/setup-android-replay-host/action.yml',
    'Android SDK, KVM and emulator-host setup',
    [
      'Resolve agent-device daemon state',
      'Enable KVM',
      'Resolve Android helper source hash',
      'Install Android helper SDK packages',
      'Verify packaged Android helpers',
    ],
  ),

  ...steps(
    '.github/actions/setup-test-app-dependencies/action.yml',
    'Expo test-app dependency setup',
    ['Resolve test app dependency cache key', 'Install test app dependencies'],
  ),

  ...steps(
    '.github/actions/setup-fixture-app/action.yml',
    'fixture-app cache lookup, download and staging for the device lanes',
    [
      'Ensure Android artifact build tools',
      'Fetch the cached Release binary',
      'Build the Release app (fallback)',
      'Locate fixture app',
      'Repack the cached app with the current JS',
      'Install fixture app',
      'Build the Android Release APK (fallback)',
      'Locate fixture APK',
      'Repack the cached APK with the current JS',
    ],
  ),

  ...steps('android.yml', 'Android device-lane orchestration against the booted emulator', [
    'Report fixture cache source',
    'Run Android emulator catalog coverage contract',
  ]),

  ...steps(
    'ci.yml',
    'inline grep assertions, the Node 22.12 floor where pnpm cannot start, and daemon cleanup around the suites',
    [
      'Disallow trailing commas before closing parenthesis in Swift',
      'Fail if test-only DI seams reappear in production code',
      'Verify the published package on Node.js 22.12',
      'Run integration tests',
      'Run live web smoke',
    ],
  ),

  ...steps(
    '.github/actions/setup-apple-runner-build/action.yml',
    "Apple runner build-cache identity; the build itself is the caller's build-command input",
    [
      'Resolve Xcode cache identity',
      'Resolve Apple runner source hash',
      'Resolve Apple runner build variant',
      'Build Apple runner artifacts on cache miss',
    ],
  ),

  ...steps(
    '.github/actions/boot-ios-test-simulator/action.yml',
    'boots and settles the iOS simulator',
    ['Resolve and boot iOS test simulator'],
  ),

  ...steps('conformance-differential.yml', 'pinned Maestro CLI install and its version assertion', [
    'Verify the installed app is the one the scenarios target',
    'Install pinned Maestro CLI',
    'Verify the Maestro CLI matches the oracle pin',
  ]),

  ...steps(
    'conformance-regenerate.yml',
    'regeneration diff assertion and the fixture-seal verification',
    ['Fail if regeneration changed anything', 'Verify fixture seals and conformance'],
  ),

  ...steps(
    'ios.yml',
    'iOS device-lane orchestration against the booted simulator or attached device',
    [
      'Set fixture producer wait policy',
      'Establish host focus canary',
      'Run targeted iOS runner XCTest regressions',
      'Preflight iOS runner through public CLI',
      'Run iOS Settings replay smoke test',
      'Report fixture cache source',
      'Run fixture-backed iOS simulator E2E smoke',
      'Assert simulator automation preserved host focus',
      'Run iOS physical device smoke replay',
    ],
  ),

  ...steps('linux.yml', 'Linux desktop session setup (Xvfb, D-Bus, AT-SPI) and the replay smoke', [
    'Install Linux desktop dependencies',
    'Start Xvfb and D-Bus',
    'Start AT-SPI2 registry',
    'Verify environment',
    'Run Linux replay smoke test',
  ]),

  ...steps(
    'mutation-affected.yml',
    'shard-matrix derivation and the failure-path envelope recorders (#1430)',
    [
      'Derive the affected shard matrix',
      'Run mutants for ${{ matrix.name }}',
      'Ratchet the affected modules',
    ],
  ),

  ...steps(
    'mutation-weekly.yml',
    'shard-matrix derivation and the failure-path envelope recorders (#1430)',
    [
      'Run mutants for ${{ matrix.name }}',
      'Ratchet the merged sweep and propose the next baseline',
      'Lane envelope',
    ],
  ),

  ...steps(
    'perf-nightly.yml',
    'perf-lane orchestration and the benchmark, which reports rather than gates',
    ['Preflight iOS runner through public CLI', 'Run iOS command perf benchmark'],
  ),

  ...steps('replays-nightly.yml', 'nightly device-lane orchestration', [
    'Summarize',
    'Mark Android emulator setup complete',
    'Preflight iOS runner through public CLI',
    'Report fixture cache source',
    'Prove selector drag reaches its destination on iOS',
    'Run full fixture-backed iOS simulator E2E',
  ]),

  ...steps(
    'size.yml',
    'bundle-size measurement, which reports rather than gates, and runs at the PR base commit',
    [
      'Preserve report script',
      'Measure base size',
      'Measure PR size',
      'Add job summary',
      'Comment on PR',
    ],
  ),

  ...steps('test-app-build-cache.yml', 'Expo release app build and artifact staging', [
    'Resolve native fingerprint',
    'Build the iOS Release app',
    'Install Android SDK packages',
    'Build the Android Release apk',
    'Stage the binary for upload',
  ]),
];
