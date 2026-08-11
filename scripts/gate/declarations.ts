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

/**
 * Values a workflow passes to an action input the action EXECUTES.
 *
 * `setup-apple-runner-build` runs `${{ inputs.build-command }}`, so the shell that lane
 * runs is written at the CALL SITE, not in the action. The action's own step therefore has
 * a constant digest and can vouch for nothing (review round 5). The model turns each such
 * value into a step of the calling lane, which is why these are ordinary entries here: the
 * same rule decides them, and a caller that swaps `pnpm gate swift-runner-ios` for anything
 * else changes this digest.
 *
 * An input counts as executed if the action interpolates it into any `run:` block — no
 * attempt is made to work out whether the value lands in command position, because that is
 * the shell-context reconstruction this design refuses to do. So the digest also covers
 * data-ish neighbours (a platform name, a device name, a timeout), and one entry per call
 * site is the price. A new caller of the same action is a new entry, which is the point:
 * copying a call is a fact to review, not something the list already covers.
 *
 * Round 6: the same applies to THIRD-PARTY actions, whose executable inputs are declared in
 * `EXTERNAL_ACTIONS` rather than read from the action. The largest command in CI turns out
 * to live at one of these call sites — the Android smoke suite runs inside
 * `android-emulator-runner`'s `script:` input — and before it was modelled, editing it
 * moved no digest at all.
 */
const EXECUTED_INPUTS: readonly Unrouted[] = [
  ...steps('android.yml', 'Android fixture APK restore, staged without installing', [
    [
      'c2bc6863c083',
      'Restore fixture APK → setup-fixture-app (platform, wait-for-artifact-seconds, require-artifact)',
    ],
  ]),

  ...steps(
    'android.yml',
    'the Android smoke suite itself: resolves the emulator serial, builds through `pnpm gate build`, then runs the emulator smoke test and one replay',
    [
      [
        'b346a3b0abcd',
        'Run Android smoke checks → reactivecircus/android-emulator-runner@b530d96654c385303d652368551fb075bc2f0b6b (emulator-options, script)',
      ],
    ],
  ),

  ...steps(
    'ci.yml',
    'macOS runner build for the Swift unit-test surface, gated and carrying the unit-test opt-in',
    [
      [
        'ea808cb7887b',
        'Restore and compile Swift runner unit-test surface → setup-apple-runner-build (build-command, xcuitest-platform, xcuitest-destination)',
      ],
    ],
  ),

  ...steps('conformance-differential.yml', 'iOS runner build, simulator boot and fixture app', [
    [
      '28d1645e76e6',
      'Restore and build iOS XCTest runner → setup-apple-runner-build (build-command, xcuitest-platform, xcuitest-destination)',
    ],
    [
      '1901b9e89afd',
      'Boot simulator → boot-ios-test-simulator (runtime-version, preferred-device-name, boot-timeout-seconds)',
    ],
    [
      'f3c6fc4398e1',
      'Setup fixture app → setup-fixture-app (platform, wait-for-artifact-seconds, require-artifact)',
    ],
  ]),

  ...steps('ios.yml', 'iOS runner build, simulator boot and fixture app', [
    [
      '28d1645e76e6',
      'Restore and build iOS XCTest runner → setup-apple-runner-build (build-command, xcuitest-platform, xcuitest-destination)',
    ],
    [
      '1901b9e89afd',
      'Boot iOS test simulator → boot-ios-test-simulator (runtime-version, preferred-device-name, boot-timeout-seconds)',
    ],
    [
      '9699d88529c4',
      'Fetch current fixture app → setup-fixture-app (platform, wait-for-artifact-seconds, require-artifact)',
    ],
  ]),

  ...steps('macos.yml', 'macOS runner build for the replay lane', [
    [
      '7d2447a2c51b',
      'Restore and build macOS XCTest runner → setup-apple-runner-build (build-command, xcuitest-platform, xcuitest-destination)',
    ],
  ]),

  ...steps(
    'pr-preview.yml',
    'website preview deploy: the values pr-preview-action interpolates into its own `run:` blocks',
    [
      [
        'e546cec1d5a3',
        'Deploy preview → rossjrw/pr-preview-action@ffa7509e91a3ec8dfc2e5536c4d5c1acdf7a6de9 (preview-branch, qr-code, source-dir)',
      ],
    ],
  ),

  ...steps(
    'pr-preview-cleanup.yml',
    'website preview teardown: the same call with the same values, from the cleanup lane',
    [
      [
        'e546cec1d5a3',
        'Remove preview → rossjrw/pr-preview-action@ffa7509e91a3ec8dfc2e5536c4d5c1acdf7a6de9 (preview-branch, qr-code, source-dir)',
      ],
    ],
  ),

  ...steps('perf-nightly.yml', 'iOS runner build and simulator boot for the benchmark lane', [
    [
      '28d1645e76e6',
      'Restore and build iOS XCTest runner → setup-apple-runner-build (build-command, xcuitest-platform, xcuitest-destination)',
    ],
    [
      '1901b9e89afd',
      'Boot iOS test simulator → boot-ios-test-simulator (runtime-version, preferred-device-name, boot-timeout-seconds)',
    ],
  ]),

  ...steps(
    'perf-nightly.yml',
    'the Android benchmark suite, run inside the emulator action the same way the smoke lane runs its own',
    [
      [
        '01e17764b28e',
        'Run Android command perf benchmark → reactivecircus/android-emulator-runner@b530d96654c385303d652368551fb075bc2f0b6b (emulator-options, script)',
      ],
    ],
  ),

  ...steps(
    'replays-nightly.yml',
    'the nightly Android replay sweep, run inside the emulator action',
    [
      [
        'e4179061b70b',
        'Run Android full emulator suite → reactivecircus/android-emulator-runner@b530d96654c385303d652368551fb075bc2f0b6b (emulator-options, script)',
      ],
    ],
  ),

  ...steps('replays-nightly.yml', 'Apple runner builds, simulator boot and fixture apps', [
    [
      '054dcdc23b3f',
      'Restore Android fixture APK → setup-fixture-app (platform, wait-for-artifact-seconds, require-artifact)',
    ],
    [
      '28d1645e76e6',
      'Restore and build iOS XCTest runner → setup-apple-runner-build (build-command, xcuitest-platform, xcuitest-destination)',
    ],
    [
      '1901b9e89afd',
      'Boot iOS test simulator → boot-ios-test-simulator (runtime-version, preferred-device-name, boot-timeout-seconds)',
    ],
    [
      'f3c6fc4398e1',
      'Fetch current fixture app → setup-fixture-app (platform, wait-for-artifact-seconds, require-artifact)',
    ],
    [
      '7d2447a2c51b',
      'Restore and build macOS XCTest runner → setup-apple-runner-build (build-command, xcuitest-platform, xcuitest-destination)',
    ],
  ]),
];

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

  ...EXECUTED_INPUTS,
];

/**
 * Workflow- and job-level `env:` a qualifying lane inherits. Every step in the lane sees
 * it, so one `NODE_OPTIONS=--import ./x.ts` here would inject into every gate step at
 * once — which is why the lane's environment is fingerprinted like a step body.
 */
export type LaneEnvironment = {
  readonly workflow: string;
  readonly job: string;
  readonly digest: string;
  readonly reason: string;
};

export const LANE_ENVIRONMENTS: readonly LaneEnvironment[] = [
  {
    workflow: 'ci.yml',
    job: 'Web Platform Smoke',
    digest: '891c2cae5eb2',
    reason: 'opts the web platform smoke into its live-browser mode (AGENT_DEVICE_WEB_E2E)',
  },
  {
    workflow: 'concurrency-torture-nightly.yml',
    job: 'Concurrency Torture Nightly / Session/lease/lock torture sweep',
    digest: 'c9ae66e1a918',
    reason:
      'sweep size, seed and envelope path for the torture lane (TORTURE_ENVELOPE, TORTURE_RUNS, TORTURE_SEED_START)',
  },
  {
    workflow: 'conformance-differential.yml',
    job: 'Conformance Differential / iOS Conformance Differential',
    digest: '6a253505c017',
    reason:
      'simulator identity, CLI path and Maestro analytics opt-out (AGENT_DEVICE_CLI, AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH, AGENT_DEVICE_STATE_DIR, DIFFERENTIAL_ONLY, IOS_RUNTIME_VERSION, MAESTRO_CLI_NO_ANALYTICS)',
  },
  {
    workflow: 'ios.yml',
    job: 'iOS / Smoke Tests',
    digest: 'd92263e1990d',
    reason:
      'simulator runtime, derived-data and state paths, and the app event URL template (AGENT_DEVICE_IOS_APP_EVENT_URL_TEMPLATE, AGENT_DEVICE_IOS_PREPARE_TIMEOUT_MS, AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH, AGENT_DEVICE_STATE_DIR, AGENT_DEVICE_XCUITEST_INCLUDE_UNIT_TESTS, IOS_RUNTIME_VERSION)',
  },
  {
    workflow: 'linux.yml',
    job: 'Linux / Smoke Tests',
    digest: 'e0f4b71e0be8',
    reason:
      'the Xvfb/AT-SPI desktop session the replay smoke needs (DISPLAY, GSETTINGS_BACKEND, GTK_A11Y, GTK_MODULES, NO_AT_BRIDGE, XDG_SESSION_TYPE)',
  },
  {
    workflow: 'macos.yml',
    job: 'macOS / Smoke Tests',
    digest: '6946ade697b3',
    reason:
      'derived-data and daemon state paths for the macOS runner (AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH, AGENT_DEVICE_STATE_DIR)',
  },
  {
    workflow: 'perf-nightly.yml',
    job: 'Perf Nightly / iOS Command Perf',
    digest: '5b24d473c591',
    reason:
      'benchmark round count, CLI path and device identity (AGENT_DEVICE_IOS_PREPARE_TIMEOUT_MS, AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH, AGENT_DEVICE_PERF_CLI, AGENT_DEVICE_STATE_DIR, IOS_RUNTIME_VERSION, PERF_ROUNDS)',
  },
  {
    workflow: 'perf-nightly.yml',
    job: 'Perf Nightly / Android Command Perf',
    digest: '4fce57762d05',
    reason:
      'benchmark round count, CLI path and device identity (AGENT_DEVICE_PERF_CLI, PERF_ROUNDS)',
  },
  {
    workflow: 'replays-nightly.yml',
    job: 'Replay Nightly / Android Full Emulator Suite',
    digest: '823688085eb9',
    reason:
      'device identity and state paths for the nightly replay suites (AGENT_DEVICE_STATE_DIR)',
  },
  {
    workflow: 'replays-nightly.yml',
    job: 'Replay Nightly / iOS Replay Suite',
    digest: '5aa7701df728',
    reason:
      'device identity and state paths for the nightly replay suites (AGENT_DEVICE_IOS_APP_EVENT_URL_TEMPLATE, AGENT_DEVICE_IOS_PREPARE_TIMEOUT_MS, AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH, AGENT_DEVICE_STATE_DIR, IOS_RUNTIME_VERSION)',
  },
  {
    workflow: 'replays-nightly.yml',
    job: 'Replay Nightly / macOS Replay Suite',
    digest: '6946ade697b3',
    reason:
      'device identity and state paths for the nightly replay suites (AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH, AGENT_DEVICE_STATE_DIR)',
  },
];

/**
 * Third-party actions, and which of their inputs they execute as shell.
 *
 * A LOCAL composite action is read: `workflows.ts` finds the inputs it interpolates into
 * a `run:` block and treats the caller's values as steps of the calling lane. A
 * third-party action cannot be read — its source is not in this tree — so the same fact
 * is declared here, per PINNED ref.
 *
 * Pinning is what makes a declaration meaningful. `owner/repo@<sha>` names immutable
 * content, so "this version executes these inputs" is a checkable claim about a specific
 * file rather than a guess about a moving tag. Bumping the pin changes the key, which
 * fails as undeclared until someone re-reads the new version's `action.yml`.
 *
 * Fails in both directions, like every other declaration here: an action no entry names
 * fails as undeclared (audit.ts `external`), and an entry naming an action no lane uses
 * fails as inert. `executes: []` is a positive claim — "I read this version and it takes
 * no shell from its caller" — not an absence.
 *
 * Each entry below was checked against `action.yml` at the pinned sha. What a caller
 * OMITS is not audited: that value comes from the pinned action's own default, which the
 * pin freezes and this review covers.
 *
 * Scoped to lanes that gate the way in, so the list is exactly the surface the no-bypass
 * rule rests on. `JamesIves/github-pages-deploy-action` is therefore absent — deploy.yml
 * runs on push — and would become required the day a `pull_request` lane used it.
 */
export type ExternalAction = {
  /** `owner/repo@ref`, exactly as the workflow spells it, comment excluded. */
  readonly uses: string;
  /** Inputs whose values this version runs as shell. Empty is a claim, not a default. */
  readonly executes: readonly string[];
  readonly reason: string;
};

export const EXTERNAL_ACTIONS: readonly ExternalAction[] = [
  {
    uses: 'reactivecircus/android-emulator-runner@b530d96654c385303d652368551fb075bc2f0b6b',
    executes: ['script', 'pre-emulator-launch-script', 'working-directory', 'emulator-options'],
    reason:
      'runs `script` and `pre-emulator-launch-script` in a shell on the emulator host; ' +
      '`working-directory` is the root it runs them from and `emulator-options` goes on the ' +
      'emulator command line. This is the action the Android smoke lanes drive the whole ' +
      'suite through, so its `script` value is the largest single command in CI.',
  },
  {
    uses: 'rossjrw/pr-preview-action@ffa7509e91a3ec8dfc2e5536c4d5c1acdf7a6de9',
    executes: [
      'action',
      'comment',
      'custom-url',
      'deploy-commit-message',
      'deploy-repository',
      'git-config-email',
      'git-config-name',
      'pages-base-path',
      'pages-base-url',
      'pr-number',
      'preview-branch',
      'qr-code',
      'remove-commit-message',
      'source-dir',
      'token',
      'umbrella-dir',
      'wait-for-pages-deployment',
    ],
    reason:
      'a composite action: every input listed here is interpolated into one of its `run:` ' +
      'blocks, which is the same test `workflows.ts` applies to local composites. Listed in ' +
      'full rather than narrowed to the three this repo passes, so adding a fourth is caught.',
  },
  {
    uses: 'pnpm/action-setup@41ff72655975bd51cab0327fa583b6e92b6d3061',
    executes: ['run_install'],
    reason:
      '`run_install` is a YAML spec of pnpm install invocations the action executes; the ' +
      'rest (version, dest, package_json_file, standalone) select or locate the binary.',
  },
  {
    uses: 'gradle/actions/setup-gradle@ed408507eac070d1f99cc633dbcf757c94c7933a',
    executes: ['arguments'],
    reason:
      '`arguments` is the (deprecated) Gradle command line the action runs after setup. This ' +
      'repo does not pass it today, so the declaration is what makes passing it visible.',
  },
  {
    uses: 'actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd',
    executes: [],
    reason: 'node action; every input names a ref, path, token or checkout flag.',
  },
  {
    uses: 'actions/checkout@8e8c483db84b4bee98b60c0593521ed34d9990e8',
    executes: [],
    reason:
      'the same action at an older pin, still used by three workflows; inputs as above. Two ' +
      'entries rather than one is the point of keying on the sha.',
  },
  {
    uses: 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
    executes: [],
    reason: 'node action; inputs are a name, glob paths and retention flags.',
  },
  {
    uses: 'actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093',
    executes: [],
    reason: 'node action; inputs are a name, pattern, path and token.',
  },
  {
    uses: 'actions/cache/save@0057852bfaa89a56745cba8c7296529d2fc39830',
    executes: [],
    reason: 'node action; inputs are cache key, paths and upload-chunk sizing.',
  },
  {
    uses: 'actions/cache/restore@0057852bfaa89a56745cba8c7296529d2fc39830',
    executes: [],
    reason: 'node action; inputs are cache key, restore keys and paths.',
  },
  {
    uses: 'actions/setup-node@6044e13b5dc448c55e2357c09f80417699197238',
    executes: [],
    reason: 'node action; inputs select a Node version, registry and cache strategy.',
  },
  {
    uses: 'actions/setup-java@c1e323688fd81a25caa38c78aa6df2d33d3e20d9',
    executes: [],
    reason: 'node action; inputs select a JDK, distribution and Maven settings.',
  },
  {
    uses: 'oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6',
    executes: [],
    reason: 'node action; inputs select a Bun version, download URL and registry.',
  },
];
