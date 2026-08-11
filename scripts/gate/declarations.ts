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
  /** Human label only. The DIGEST is what is matched — a name is mutable metadata. */
  readonly step: string;
  /**
   * Fingerprint of the step's executable identity: `run` plus every execution-affecting
   * key (`env`, `shell`, `working-directory`). Editing any of them makes this entry stop
   * matching, so the step becomes unlisted and the entry becomes inert at the same time.
   * `pnpm check:gate-manifest` prints the current digest when one does not match.
   */
  readonly digest: string;
  readonly reason: string;
};

const steps = (
  workflow: string,
  reason: string,
  entries: readonly (readonly [digest: string, step: string])[],
): Unrouted[] => entries.map(([digest, step]) => ({ workflow, step, digest, reason }));

export const NON_GATE_STEPS: readonly Unrouted[] = [
  ...steps(
    '.github/actions/setup-node-pnpm/action.yml',
    'toolchain setup: pins pnpm to packageManager and installs dependencies',
    [
      ['41219311e090', 'Resolve pnpm version from packageManager'],
      ['0387cba3d55b', 'Assert pnpm matches packageManager'],
      ['3d5a9aa23cac', 'Install dependencies'],
    ],
  ),

  ...steps(
    '.github/actions/setup-android-replay-host/action.yml',
    'Android SDK, KVM and emulator-host setup',
    [
      ['4c95d2bc3461', 'Resolve agent-device daemon state'],
      ['11bef5c793af', 'Enable KVM'],
      ['18a370b8fb17', 'Resolve Android helper source hash'],
      ['4ec0d4376bd6', 'Install Android helper SDK packages'],
      ['54920b131266', 'Verify packaged Android helpers'],
    ],
  ),

  ...steps(
    '.github/actions/setup-android-replay-host/action.yml',
    'gate invocation carrying env; fingerprinted because env can inject execution',
    [['5bc39413ac70', 'Package npm-bundled Android helpers']],
  ),

  ...steps(
    '.github/actions/setup-test-app-dependencies/action.yml',
    'Expo test-app dependency setup',
    [
      ['ba6d6cd8145a', 'Resolve test app dependency cache key'],
      ['44eed4516be9', 'Install test app dependencies'],
    ],
  ),

  ...steps(
    '.github/actions/setup-fixture-app/action.yml',
    'fixture-app cache lookup, download and staging for the device lanes',
    [
      ['397c8a78e2df', 'Ensure Android artifact build tools'],
      ['f7017bc64a49', 'Fetch the cached Release binary'],
      ['a5dfaa5d3f5a', 'Build the Release app (fallback)'],
      ['35528dd1eec9', 'Locate fixture app'],
      ['dd92c52ace08', 'Repack the cached app with the current JS'],
      ['85dc3176fdf4', 'Install fixture app'],
      ['64b53382aba5', 'Build the Android Release APK (fallback)'],
      ['8a75d6b6a9f1', 'Locate fixture APK'],
      ['2d1b4bb57faa', 'Repack the cached APK with the current JS'],
    ],
  ),

  ...steps('android.yml', 'Android device-lane orchestration against the booted emulator', [
    ['2d62b9316f7e', 'Report fixture cache source'],
    ['65f0e1e8591a', 'Run Android emulator catalog coverage contract'],
  ]),

  ...steps(
    'ci.yml',
    'inline grep assertions, the Node 22.12 floor where pnpm cannot start, and daemon cleanup around the suites',
    [
      ['7d72f44785ff', 'Disallow trailing commas before closing parenthesis in Swift'],
      ['977bb80cfacf', 'Fail if test-only DI seams reappear in production code'],
      ['00de3d74baf5', 'Verify the published package on Node.js 22.12'],
      ['96fe444c5201', 'Run integration tests'],
      ['09420a052135', 'Run live web smoke'],
    ],
  ),

  ...steps(
    'ci.yml',
    'gate invocation carrying env; fingerprinted because env can inject execution',
    [
      ['27033c110f7f', 'Run Fallow audit'],
      ['afe0f39bd70a', 'Run coverage'],
      ['261485f43a17', 'Enforce changed-line coverage gate'],
    ],
  ),

  ...steps(
    '.github/actions/setup-apple-runner-build/action.yml',
    "Apple runner build-cache identity; the build itself is the caller's build-command input",
    [
      ['68bd46353e4e', 'Resolve Xcode cache identity'],
      ['268697051628', 'Resolve Apple runner source hash'],
      ['6a6d8aef7c78', 'Resolve Apple runner build variant'],
      ['7af6f73d05e8', 'Build Apple runner artifacts on cache miss'],
    ],
  ),

  ...steps(
    '.github/actions/boot-ios-test-simulator/action.yml',
    'boots and settles the iOS simulator',
    [['f3d2c3174490', 'Resolve and boot iOS test simulator']],
  ),

  ...steps('conformance-differential.yml', 'pinned Maestro CLI install and its version assertion', [
    ['78ef1dbf019c', 'Verify the installed app is the one the scenarios target'],
    ['ae452f2af223', 'Install pinned Maestro CLI'],
    ['aab5fb9ce671', 'Verify the Maestro CLI matches the oracle pin'],
    ['e2a39626f485', 'Run differential'],
  ]),

  ...steps(
    'conformance-regenerate.yml',
    'regeneration diff assertion and the fixture-seal verification',
    [
      ['17b1db3209a8', 'Fail if regeneration changed anything'],
      ['fb4f1fc9e03c', 'Verify fixture seals and conformance'],
    ],
  ),

  ...steps(
    'ios.yml',
    'iOS device-lane orchestration against the booted simulator or attached device',
    [
      ['eaca4542cef9', 'Set fixture producer wait policy'],
      ['62b370048948', 'Establish host focus canary'],
      ['cbc5df84affa', 'Run targeted iOS runner XCTest regressions'],
      ['92918d83107d', 'Preflight iOS runner through public CLI'],
      ['e6ca1d4bf6bc', 'Run iOS Settings replay smoke test'],
      ['8247e4be6bf3', 'Report fixture cache source'],
      ['72f933b9e08f', 'Assert simulator automation preserved host focus'],
      ['a3b6685baf76', 'Run iOS physical device smoke replay'],
    ],
  ),

  ...steps(
    'ios.yml',
    'gate invocation carrying env; fingerprinted because env can inject execution',
    [['522da450f393', 'Run fixture-backed iOS simulator E2E smoke']],
  ),

  ...steps('linux.yml', 'Linux desktop session setup (Xvfb, D-Bus, AT-SPI) and the replay smoke', [
    ['d6ea8276c6dc', 'Install Linux desktop dependencies'],
    ['c67494e7066e', 'Start Xvfb and D-Bus'],
    ['55d179abe434', 'Start AT-SPI2 registry'],
    ['049e4dfb08c7', 'Verify environment'],
    ['3c9cbfebe4c9', 'Run Linux replay smoke test'],
  ]),

  ...steps(
    'mutation-affected.yml',
    'shard-matrix derivation and the failure-path envelope recorders (#1430)',
    [
      ['823b9d45dcb0', 'Derive the affected shard matrix'],
      ['a8ab8b5182b3', 'Record a failed lane envelope'],
      ['1b6eac0b3509', 'Run mutants for ${{ matrix.name }}'],
      ['7a702a60ddc3', 'Record a failed shard envelope'],
      ['f31977ec7713', 'Ratchet the affected modules'],
      ['221892da8b4b', 'Record a failed lane envelope'],
    ],
  ),

  ...steps(
    'mutation-weekly.yml',
    'shard-matrix derivation and the failure-path envelope recorders (#1430)',
    [
      ['1b6eac0b3509', 'Run mutants for ${{ matrix.name }}'],
      ['3873f41f331f', 'Record a failed shard envelope'],
      ['b25594b32ba7', 'Ratchet the merged sweep and propose the next baseline'],
      ['e13647b2fefa', 'Record a failed lane envelope'],
      ['e6a7f47eee4c', 'Lane envelope'],
    ],
  ),

  ...steps(
    'perf-nightly.yml',
    'perf-lane orchestration and the benchmark, which reports rather than gates',
    [
      ['3544460a1732', 'Preflight iOS runner through public CLI'],
      ['98f652a2e30c', 'Run iOS command perf benchmark'],
    ],
  ),

  ...steps(
    '.github/actions/build-docs/action.yml',
    "builds the website package in its own working-directory, not this package's scripts",
    [['a802705fdeb5', 'Build docs']],
  ),

  ...steps('replays-nightly.yml', 'nightly device-lane orchestration', [
    ['637427dab1d3', 'Summarize'],
    ['50120e99db45', 'Mark Android emulator setup complete'],
    ['92918d83107d', 'Preflight iOS runner through public CLI'],
    ['a98229438e10', 'Run iOS simulator replay suite'],
    ['8247e4be6bf3', 'Report fixture cache source'],
    ['d987520fe290', 'Prove selector drag reaches its destination on iOS'],
  ]),

  ...steps(
    'replays-nightly.yml',
    'gate invocation carrying env; fingerprinted because env can inject execution',
    [
      ['197ae940fa57', 'Fuzz parsers'],
      ['1b8d6fc776ae', 'Run full fixture-backed iOS simulator E2E'],
      ['45a7e46875f8', 'Run iOS physical device replay suite'],
    ],
  ),

  ...steps(
    'size.yml',
    'bundle-size measurement, which reports rather than gates, and runs at the PR base commit',
    [
      ['d579f6da75cd', 'Preserve report script'],
      ['0a2945cd88b6', 'Measure base size'],
      ['12307ef05978', 'Measure PR size'],
      ['ed11b888d999', 'Add job summary'],
      ['da40926b1e04', 'Comment on PR'],
    ],
  ),

  ...steps('test-app-build-cache.yml', 'Expo release app build and artifact staging', [
    ['ec81a594278d', 'Resolve native fingerprint'],
    ['f73b2699856e', 'Build the iOS Release app'],
    ['5baa4a7b5af5', 'Install Android SDK packages'],
    ['bd6dcf8e0dda', 'Build the Android Release apk'],
    ['6153d35b3227', 'Stage the binary for upload'],
  ]),
];
