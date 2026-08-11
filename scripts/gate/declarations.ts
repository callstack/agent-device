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
 * Why each file runs shell outside `pnpm gate`, once per declaring file.
 *
 * The step identities and digests live in the generated `baseline.json`; this is the part a
 * human writes. One reason per file rather than per step: "what is this workflow doing
 * outside the runner" is the question a reviewer actually asks, and answering it 109 times
 * produced prose nobody read.
 */
export const REASONS: Readonly<Record<string, string>> = {
  '.github/actions/boot-ios-test-simulator/action.yml': 'boots and settles the iOS simulator',
  '.github/actions/setup-android-replay-host/action.yml':
    'Android SDK, KVM and emulator-host setup',
  '.github/actions/setup-fixture-app/action.yml':
    'fixture-app cache lookup, download and staging for the device lanes',
  '.github/actions/setup-node-pnpm/action.yml':
    'toolchain setup: pins pnpm to packageManager and installs dependencies',
  '.github/actions/setup-test-app-dependencies/action.yml': 'Expo test-app dependency setup',
  'android.yml': 'Android fixture APK restore, staged without installing',
  'ci.yml':
    'macOS runner build for the Swift unit-test surface, gated and carrying the unit-test opt-in',
  'conformance-differential.yml': 'iOS runner build, simulator boot and fixture app',
  'conformance-regenerate.yml': 'regeneration diff assertion and the fixture-seal verification',
  'ios.yml': 'iOS runner build, simulator boot and fixture app',
  'linux.yml': 'Linux desktop session setup (Xvfb, D-Bus, AT-SPI) and the replay smoke',
  'macos.yml': 'macOS runner build for the replay lane',
  'mutation-affected.yml':
    'shard-matrix derivation and the failure-path envelope recorders (#1430)',
  'mutation-weekly.yml': 'shard-matrix derivation and the failure-path envelope recorders (#1430)',
  'perf-nightly.yml': 'iOS runner build and simulator boot for the benchmark lane',
  'pr-preview-cleanup.yml':
    'website preview teardown: the same call with the same values, from the cleanup lane',
  'pr-preview.yml':
    'website preview deploy: the values pr-preview-action interpolates into its own `run:` blocks',
  'replays-nightly.yml': 'the nightly Android replay sweep, run inside the emulator action',
  'size.yml':
    'bundle-size measurement, which reports rather than gates, and runs at the PR base commit',
  'test-app-build-cache.yml': 'Expo release app build and artifact staging',
};

/**
 * Local actions that run exactly one registered gate, and the input naming it.
 *
 * The seam these replace took a COMMAND (`build-command: pnpm gate swift-runner-ios`), so
 * every call site's value had to be fingerprinted — which is what rounds 5 and 6 were
 * about. Taking an id instead makes a smuggled command unrepresentable: the action runs
 * `pnpm gate "$INPUT_GATE"` and the audit checks the id against the registry.
 */
export const GATE_ACTIONS: Readonly<Record<string, string>> = {
  '.github/actions/setup-apple-runner-build/action.yml': 'gate',
};

/**
 * Environment variables CI is allowed to set, as exact names or `PREFIX_` namespaces.
 *
 * An ALLOWLIST, not a denylist, and that is the point: `NODE_OPTIONS`, `BASH_ENV`,
 * `PERL5OPT`, `LD_PRELOAD` and `PATH` each make an interpreter run code its command line
 * does not name, and none of them matches a namespace below, so none can arrive by
 * accident. Adding one is a visible edit to this list.
 *
 * This replaces fingerprinting every inherited environment. Digesting taxed eleven lanes'
 * worth of ordinary device configuration — runtime versions, state directories, an Xvfb
 * display — to catch a class of variable that can simply be named. Changing
 * `IOS_RUNTIME_VERSION` is now invisible to the audit, correctly: it configures a device,
 * it does not run code.
 */
export const ALLOWED_ENV: readonly string[] = [
  // Scoped to lanes that gate the way in, like every other declaration here, so every entry
  // is load-bearing: `MCP_PUBLISHER_` and `RELEASE_ASSET_DIR` are deliberately absent
  // because only release lanes set them.
  // The project's own namespaces.
  'AGENT_DEVICE_',
  'DIFFERENTIAL_ONLY',
  'EXPECTED_PNPM_VERSION',
  'FALLOW_BASE',
  'FUZZ_',
  'IOS_RUNTIME_VERSION',
  'IOS_UDID',
  'MAESTRO_CLI_NO_ANALYTICS',
  'OUTPUT_ECONOMY_BASE',
  'PERF_ROUNDS',
  'RSPRESS_BASE',
  'TORTURE_',
  // GitHub-supplied credentials and context.
  'GH_TOKEN',
  'GITHUB_',
  // How a composite action hands an input to its own shell. This is the mechanism that
  // replaced interpolating `${{ inputs.x }}` into a `run:` body, and it is inert by
  // construction: no interpreter reads an `INPUT_`-prefixed variable, and it is GitHub's
  // own convention for the same job.
  'INPUT_',
  // The Linux replay lane's Xvfb/AT-SPI desktop session.
  'DISPLAY',
  'GSETTINGS_BACKEND',
  'GTK_',
  'NO_AT_BRIDGE',
  'XDG_',
  // Build-tool selection that retargets no interpreter.
  'NODE_ENV',
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
