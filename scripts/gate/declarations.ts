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
 * Why each file runs shell outside `pnpm gate`, and HOW MANY such steps it is allowed.
 *
 * The step identities and digests live in the generated `baseline.json`; this is the part a
 * human writes. One reason per file rather than per step: "what is this workflow doing
 * outside the runner" is the question a reviewer actually asks, and answering it 109 times
 * produced prose nobody read.
 *
 * `steps` is what stops that from being an unowned census. Review rounds 8–10 asked three
 * times for per-edge ownership, and the objection was right for a reason none of us stated
 * concretely: because the reason was keyed per FILE and nothing checked arity, `--update`
 * would bless a brand-new step in an already-described file, and an entirely new file with no
 * description at all. Both were reproduced on this branch —
 * `run: node -e 'import("./scripts/layering/check.ts")'` added to `ios.yml`, regenerated, and
 * the audit still printed `ok`.
 *
 * Pinning the count is what makes `--update` unable to launder an addition: the number lives
 * here, in a hand-written file, so a new step fails until a human raises it and re-reads the
 * reason it is being admitted under. It fails in both directions — a deleted step drops the
 * count, and a file with no live steps is an inert declaration.
 *
 * It is deliberately NOT per-entry prose. The same review asked for the census to be compact
 * data rather than 685 lines of declarations, and per-edge reasons for 90 entries is that
 * file again. Arity is the cheapest thing that makes an unclassified step fail closed.
 */
export type NonGateFile = {
  readonly steps: number;
  /** Fingerprint over every digest this file contributes, so an EDIT moves it too. */
  readonly digest: string;
  readonly reason: string;
};

export const REASONS: Readonly<Record<string, NonGateFile>> = {
  '.github/actions/boot-ios-test-simulator/action.yml': {
    steps: 1,
    digest: 'ca68e892efdf',
    reason: 'boots and settles the iOS simulator',
  },
  '.github/actions/build-docs/action.yml': {
    steps: 1,
    digest: '0e2b2fb6bda5',
    reason: 'builds the docs site the website preview lane publishes',
  },
  '.github/actions/setup-android-replay-host/action.yml': {
    steps: 6,
    digest: '921b15bd98b5',
    reason: 'Android SDK, KVM and emulator-host setup',
  },
  '.github/actions/setup-apple-runner-build/action.yml': {
    steps: 4,
    digest: 'a46156133913',
    reason:
      'Xcode and source-hash cache identity, plus the build itself — which IS `pnpm gate ' +
      '"$INPUT_GATE"`, and is listed here rather than shape-approved only because its ' +
      '`if:` makes it conditional (see GATE_CONDITIONS)',
  },
  '.github/actions/setup-fixture-app/action.yml': {
    steps: 9,
    digest: '42f3e78c93ad',
    reason: 'fixture-app cache lookup, download and staging for the device lanes',
  },
  '.github/actions/setup-node-pnpm/action.yml': {
    steps: 3,
    digest: 'ddbdbf2865af',
    reason: 'toolchain setup: pins pnpm to packageManager and installs dependencies',
  },
  '.github/actions/setup-test-app-dependencies/action.yml': {
    steps: 2,
    digest: '4f30932a31ab',
    reason: 'Expo test-app dependency setup',
  },
  'android.yml': {
    steps: 3,
    digest: '6edeacac4689',
    reason: 'Android fixture APK restore, staged without installing',
  },
  'ci.yml': {
    steps: 7,
    digest: '88d579c487f4',
    reason:
      'macOS runner build for the Swift unit-test surface, gated and carrying the unit-test opt-in',
  },
  'conformance-differential.yml': {
    steps: 3,
    digest: '19ab7eb32746',
    reason: 'iOS runner build, simulator boot and fixture app',
  },
  'conformance-regenerate.yml': {
    steps: 2,
    digest: '3b3d227e496f',
    reason: 'regeneration diff assertion and the fixture-seal verification',
  },
  'ios.yml': {
    steps: 9,
    digest: '527ddc9a1cf9',
    reason: 'iOS runner build, simulator boot and fixture app',
  },
  'linux.yml': {
    steps: 5,
    digest: '6ca589e02882',
    reason: 'Linux desktop session setup (Xvfb, D-Bus, AT-SPI) and the replay smoke',
  },
  'mutation-affected.yml': {
    steps: 6,
    digest: '9f6643ba2748',
    reason: 'shard-matrix derivation and the failure-path envelope recorders (#1430)',
  },
  'mutation-weekly.yml': {
    steps: 5,
    digest: '8eea701004fe',
    reason: 'shard-matrix derivation and the failure-path envelope recorders (#1430)',
  },
  'perf-nightly.yml': {
    steps: 3,
    digest: '64ae26c62c53',
    reason: 'iOS runner build and simulator boot for the benchmark lane',
  },
  'pr-preview-cleanup.yml': {
    steps: 1,
    digest: '27f277c85817',
    reason: 'website preview teardown: the same call with the same values, from the cleanup lane',
  },
  'pr-preview.yml': {
    steps: 1,
    digest: '27f277c85817',
    reason:
      'website preview deploy: the values pr-preview-action interpolates into its own `run:` blocks',
  },
  'replays-nightly.yml': {
    steps: 9,
    digest: 'd32431a2fd5e',
    reason: 'the nightly Android replay sweep, run inside the emulator action',
  },
  'size.yml': {
    steps: 5,
    digest: '3b5e45395193',
    reason:
      'bundle-size measurement, which reports rather than gates, and runs at the PR base commit',
  },
  'test-app-build-cache.yml': {
    steps: 5,
    digest: '3e3ac719f52b',
    reason: 'Expo release app build and artifact staging',
  },
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
 * The closed vocabulary of every local-action input that reaches a shell body.
 *
 * Rounds 8, 9 and 10 all reported the same P1: an action can bind
 * `INPUT_COMMAND: ${{ inputs.command }}` and run the constant body `bash -c "$INPUT_COMMAND"`.
 * The body's digest never moves, `INPUT_` is allowed as a namespace, and nothing looks at the
 * caller's value — so later callers introduce arbitrary execution with no finding.
 *
 * Asking what a body DOES with a variable is the content analysis this design refuses, and
 * would lose to `eval`, `$X` bare, indirect expansion and the rest. Asking whether the body
 * MENTIONS the variable is a substring scan. So `workflows.ts` finds every input an action
 * dereferences, and the constraint goes on the caller's VALUE, which is a literal in this
 * tree and therefore decidable:
 *
 *   every input a local action's shell dereferences must be listed here, with the exact set
 *   of values callers may pass.
 *
 * A command string cannot be a member of a closed set of literals, so the reported attack is
 * unrepresentable rather than policed: an undeclared dereferenced input fails, and a value
 * outside the set fails. An expression is admitted only by being written out verbatim, which
 * puts `${{ github.event.pull_request.title }}` in a diff rather than in a shell.
 *
 * Nine inputs across three actions, which is the whole surface. `gate` is absent because
 * `GATE_ACTIONS` already constrains it to a registered CheckId — a tighter rule than a value
 * list, and `gateIds` enforces it.
 */
export type TypedInput = { readonly values: readonly string[]; readonly reason: string };

export const TYPED_INPUTS: Readonly<Record<string, Readonly<Record<string, TypedInput>>>> = {
  '.github/actions/boot-ios-test-simulator/action.yml': {
    'boot-timeout-seconds': {
      values: ['300'],
      reason: 'seconds to wait for the simulator; every lane takes the action default',
    },
    'preferred-device-name': {
      values: ['iPhone 17 Pro'],
      reason: 'the simulator model the device lanes boot',
    },
    'runtime-version': {
      values: ['${{ env.IOS_RUNTIME_VERSION }}'],
      reason:
        'the iOS runtime, always from the workflow env of the same name — which is itself on ' +
        'ALLOWED_ENV, so both halves are named rather than assumed',
    },
  },
  '.github/actions/setup-apple-runner-build/action.yml': {
    'xcuitest-destination': {
      values: ['platform=macOS,arch=arm64', 'generic/platform=iOS Simulator'],
      reason: 'the `-destination` xcodebuild is given, one per platform',
    },
    'xcuitest-platform': {
      values: ['macos', 'ios'],
      reason: 'selects the build variant; every caller passes one explicitly',
    },
  },
  '.github/actions/setup-fixture-app/action.yml': {
    platform: { values: ['android', 'ios'], reason: 'which fixture app to stage' },
    'require-artifact': {
      values: ['true', 'false'],
      reason: 'whether a missing artifact fails the lane or falls back to a local build',
    },
    'wait-for-artifact-seconds': {
      values: ['0', '600', '${{ steps.fixture-producer.outputs.wait-seconds }}'],
      reason:
        'how long to wait for the producing workflow — `0` is the action default (do not ' +
        'wait). The expression form is the producer job’s own output, written out so a ' +
        'different source would be a visible edit',
    },
  },
};

/**
 * What an `if:` on a gate step means for ownership, declared per exact condition.
 *
 * A lane earns credit for `pnpm gate x` because that step RUNS. A conditional step may not,
 * and no amount of digesting fixes that: adding `if:` to the digest (round 9) makes an
 * unapproved edit fail against the old baseline, but `--update` then records the new digest
 * and `if: false` credits a gate that cannot run. The baseline is generated, so it cannot be
 * where this is decided. This list is hand-written, which is exactly why `--update` cannot
 * launder it.
 *
 * Undeclared means no credit, so `if: false` — or any other condition nobody has ruled on —
 * unowns whatever it guarded, which is the loud direction. `credits: false` says the same
 * thing deliberately, for conditions that exist and should not count.
 *
 * Six conditions guard the 19 conditional gate steps in the tree; the other 51 are
 * unconditional and need nothing here.
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
