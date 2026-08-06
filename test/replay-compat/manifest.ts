/**
 * The frozen `.ad` replay-compat corpus (#1417): one minimal witness per
 * materially distinct script surface a RELEASED version wrote, paired with the
 * verdict today's parser must return for it.
 *
 * The scripts under `scripts/` are FROZEN. A grammar change that flips a verdict
 * edits the verdict here — never the script — and says why in the same PR. See
 * `README.md`.
 */

import type { AppErrorCode } from '@agent-device/kernel/errors';

/**
 * Every release tag the corpus draws from. `pnpm check:replay-compat` verifies
 * each one against `git tag --list`, so an entry cannot claim a version that was
 * never cut.
 */
export const REPLAY_COMPAT_RELEASED_TAGS: readonly string[] = [
  'v0.11.0',
  'v0.11.2',
  'v0.15.1',
  'v0.16.0',
  'v0.16.8',
  'v0.20.0',
  'v0.20.5',
];

/**
 * Where the frozen bytes came from, and the identity that pins them there.
 *
 * - `mined`: the corpus file IS the historical blob. `blob` is that blob's git
 *   object id, so hashing the checked-in bytes reproduces it (the corpus test)
 *   and `git rev-parse <recordedBy>:<path>` reproduces it from history
 *   (`pnpm check:replay-compat`). Rewriting the script cannot stay green.
 * - `derived`: a surface the released grammar wrote that no shipped `.ad` file
 *   in this repo carries, composed from the release's own grammar/docs. There is
 *   no historical blob to point at, so the bytes are pinned by digest.
 */
export type ReplayCompatProvenance =
  | { kind: 'mined'; path: string; blob: string }
  | { kind: 'derived'; from: string; sha256: string };

/** `parses`, or the migration refusal the parser owes a script of this vintage. */
export type ReplayCompatVerdict =
  | { kind: 'parses' }
  | { kind: 'fails'; code: AppErrorCode; hint: string };

/** The historical surface an entry exists to hold still. */
export type ReplayCompatCoverage =
  | 'context-header'
  | 'env-vars'
  | 'quoting'
  | 'retired-capture-size'
  | 'retired-gesture'
  | 'target-annotation'
  | 'wait-landmark';

export type ReplayCompatEntry = {
  id: string;
  /** Corpus-relative path of the frozen script. */
  file: string;
  /** The released tag whose grammar produced this surface. */
  recordedBy: string;
  provenance: ReplayCompatProvenance;
  covers: ReplayCompatCoverage[];
  verdict: ReplayCompatVerdict;
  /** The shipped form or refusal this entry is the sole witness of. */
  note: string;
};

/**
 * Mined from the git history of `test/integration/replays` and
 * `examples/test-app/replays`, plus surfaces the released grammar wrote that
 * those suites never exercised.
 *
 * This is a parser-compatibility corpus, not a device matrix: an entry earns its
 * place by being the only witness of a shipped syntactic form or of a distinct
 * migration refusal. Repeating a form across platforms or adjacent releases adds
 * maintenance weight and no parser leverage, so those samples stay out.
 * Git-history-only grammar states that never shipped are deliberately absent.
 */
export const REPLAY_COMPAT_CORPUS: ReplayCompatEntry[] = [
  {
    id: 'integration/android-01-settings@v0.11.0',
    file: 'scripts/integration/android-01-settings.v0.11.0.ad',
    recordedBy: 'v0.11.0',
    provenance: {
      kind: 'mined',
      path: 'test/integration/replays/android/01-settings.ad',
      blob: 'c91ca3f53082fa1cabcd6df885dd14714d481177',
    },
    covers: ['context-header', 'quoting'],
    verdict: { kind: 'parses' },
    note: 'Sole shipped witness of `appstate`, `snapshot -i`, `is exists "<selector>"`, and bare `back`.',
  },
  {
    id: 'integration/ios-device-01-physical-lifecycle@v0.11.0',
    file: 'scripts/integration/ios-device-01-physical-lifecycle.v0.11.0.ad',
    recordedBy: 'v0.11.0',
    provenance: {
      kind: 'mined',
      path: 'test/integration/replays/ios/device/01-physical-lifecycle.ad',
      blob: '7f7f6cd974b1358a0ac9e210ad172ab38132ec2f',
    },
    covers: ['context-header', 'quoting', 'wait-landmark'],
    verdict: { kind: 'parses' },
    note: 'Sole shipped witness of an unquoted `open <bundle-id>` target and an argument-less `snapshot`.',
  },
  {
    id: 'integration/android-02-deep-navigation@v0.11.2',
    file: 'scripts/integration/android-02-deep-navigation.v0.11.2.ad',
    recordedBy: 'v0.11.2',
    provenance: {
      kind: 'mined',
      path: 'test/integration/replays/android/02-deep-navigation.ad',
      blob: '483bccac102023cf8116dab9eca04db37f218851',
    },
    covers: ['context-header', 'quoting', 'wait-landmark'],
    verdict: { kind: 'parses' },
    note: 'Sole shipped witness of `screenshot <path>`, a bare `click @ref`, and `find text "…" exists`.',
  },
  {
    id: 'integration/android-04-text-input-keyboard@v0.11.2',
    file: 'scripts/integration/android-04-text-input-keyboard.v0.11.2.ad',
    recordedBy: 'v0.11.2',
    provenance: {
      kind: 'mined',
      path: 'test/integration/replays/android/04-text-input-keyboard.ad',
      blob: '4dbdc1c01cd4600a9d5cbdef7e5c62a07ce6848a',
    },
    covers: ['context-header', 'wait-landmark'],
    verdict: { kind: 'parses' },
    note: 'Sole shipped witness of `type "<text>"`.',
  },
  {
    id: 'integration/android-05-app-lifecycle@v0.11.2',
    file: 'scripts/integration/android-05-app-lifecycle.v0.11.2.ad',
    recordedBy: 'v0.11.2',
    provenance: {
      kind: 'mined',
      path: 'test/integration/replays/android/05-app-lifecycle.ad',
      blob: 'ee20d0724568ef8d91b96726b10a705d216b9c2e',
    },
    covers: ['context-header', 'wait-landmark'],
    verdict: { kind: 'parses' },
    note: 'Sole shipped witness of `home`.',
  },
  {
    id: 'integration/android-06-swipe-gestures@v0.11.2',
    file: 'scripts/integration/android-06-swipe-gestures.v0.11.2.ad',
    recordedBy: 'v0.11.2',
    provenance: {
      kind: 'mined',
      path: 'test/integration/replays/android/06-swipe-gestures.ad',
      blob: '686bace4c6eed1ea1ee4c760276347fc3986c3cc',
    },
    covers: ['context-header', 'retired-gesture', 'wait-landmark'],
    verdict: {
      kind: 'fails',
      code: 'INVALID_ARGS',
      hint: 'swipe accepts 4 arguments: x1 y1 x2 y2 (line 8). The trailing durationMs positional was removed: use "gesture pan 206 700 0 -450 300" for the same timed drag, or "swipe 206 700 206 250" for a default-duration swipe.',
    },
    note: '#1393 retired the trailing swipe durationMs; a v0.11.2 Android recording carries it and must get the migration, not a silent default-duration swipe.',
  },
  {
    id: 'examples/checkout-form-android@v0.15.1',
    file: 'scripts/examples/checkout-form-android.v0.15.1.ad',
    recordedBy: 'v0.15.1',
    provenance: {
      kind: 'mined',
      path: 'examples/test-app/replays/checkout-form-android.ad',
      blob: '53b62ff99f9ad277d749cd9e1ff76eac2769eb28',
    },
    covers: ['context-header', 'env-vars', 'quoting', 'wait-landmark'],
    verdict: { kind: 'parses' },
    note: 'Sole shipped witness of `open … --launch-url`, `keyboard dismiss`, `scroll <dir> <fraction>`, and `fill id=… "…"` with `${VAR}` header values.',
  },
  {
    id: 'examples/checkout-form-android@v0.16.8',
    file: 'scripts/examples/checkout-form-android.v0.16.8.ad',
    recordedBy: 'v0.16.8',
    provenance: {
      kind: 'mined',
      path: 'examples/test-app/replays/checkout-form-android.ad',
      blob: '8d1d0ada467ca551f66ce69dabf6cc01527a31d5',
    },
    covers: ['context-header', 'env-vars', 'quoting', 'wait-landmark'],
    verdict: { kind: 'parses' },
    note: 'Sole shipped witness of a `react-native <subcommand>` step inside a recording.',
  },
  {
    id: 'examples/gesture-lab@v0.16.0',
    file: 'scripts/examples/gesture-lab.v0.16.0.ad',
    recordedBy: 'v0.16.0',
    provenance: {
      kind: 'mined',
      path: 'examples/test-app/replays/gesture-lab.ad',
      blob: 'a47066ee1db7178ebbac3cdeb149cdffb8b1f303',
    },
    covers: ['context-header', 'env-vars', 'quoting', 'retired-gesture', 'wait-landmark'],
    verdict: {
      kind: 'fails',
      code: 'INVALID_ARGS',
      hint: 'gesture fling accepts at most 4 arguments: direction x y [distance] (line 15). The trailing durationMs positional was removed: use "gesture fling up 195 443 80", or gesture pan for timed movement.',
    },
    note: '#1393 retired the trailing fling durationMs; the shipped gesture-lab example wrote it until v0.20.0. This is the only entry for that refusal — the v0.16.8 and iOS copies of the same script repeat it.',
  },
  {
    id: 'examples/gesture-lab-android@v0.20.0',
    file: 'scripts/examples/gesture-lab-android.v0.20.0.ad',
    recordedBy: 'v0.20.0',
    provenance: {
      kind: 'mined',
      path: 'examples/test-app/replays/gesture-lab-android.ad',
      blob: 'cc626f1c00c42fb59fc7f3bdee82775ad25a76f2',
    },
    covers: ['context-header', 'env-vars', 'quoting', 'wait-landmark'],
    verdict: { kind: 'parses' },
    note: 'The post-#1393 gesture positionals as they ship today: pan (incl. `--pointer-count`), fling, pinch, rotate, transform.',
  },
  {
    id: 'docs/vars-parameterized@v0.15.1',
    file: 'scripts/docs/vars-parameterized.v0.15.1.ad',
    recordedBy: 'v0.15.1',
    provenance: {
      kind: 'derived',
      from: 'website/docs/docs/replay-e2e.md@v0.15.1 ("Parametrise `.ad` scripts")',
      sha256: 'b2797c29dd85b538505a21699ae9d4a91096ccff54ecf3694d4c194743beeae0',
    },
    covers: ['context-header', 'env-vars'],
    verdict: { kind: 'parses' },
    note: 'The shipped `${VAR}` surface as documented by the release that introduced it.',
  },
  {
    id: 'docs/vars-quoting-fallback@v0.15.1',
    file: 'scripts/docs/vars-quoting-fallback.v0.15.1.ad',
    recordedBy: 'v0.15.1',
    provenance: {
      kind: 'derived',
      from: 'website/docs/docs/replay-e2e.md@v0.15.1 ("Substitution happens inside parsed string values" / "Fallback and escape")',
      sha256: '71859426c7f4798f562482dac2024ae996d3890ff89989ef2dfd9a46e40ca4f9',
    },
    covers: ['context-header', 'env-vars', 'quoting', 'wait-landmark'],
    verdict: { kind: 'parses' },
    note: 'Quoted selector values, escaped inner quotes, and `${VAR:-default}` in one script.',
  },
  {
    id: 'docs/record-as-parameterized-fill@v0.15.1',
    file: 'scripts/docs/record-as-parameterized-fill.v0.15.1.ad',
    recordedBy: 'v0.15.1',
    provenance: {
      kind: 'derived',
      from: 'website/docs/docs/replay-e2e.md@v0.15.1 + src/replay/vars.ts@v0.15.1',
      sha256: '6d7e24c05eff2f41c9824f1b43a99a8d611dd2eaf3d5e27edf7707dd5b040a87',
    },
    covers: ['context-header', 'env-vars', 'quoting'],
    verdict: { kind: 'parses' },
    note: '`--record-as` projects a recorded value into exactly this shipped surface: an `env` declaration plus a `${VAR}` fill argument. The flag itself is not in any tag as of the v0.20.0 baseline, so the corpus freezes the released script surface, not the unreleased recorder flag.',
  },
  {
    id: 'docs/vars-reserved-env-key@v0.15.1',
    file: 'scripts/docs/vars-reserved-env-key.v0.15.1.ad',
    recordedBy: 'v0.15.1',
    provenance: {
      kind: 'derived',
      from: 'website/docs/docs/replay-e2e.md@v0.15.1 ("User-defined keys starting with AD_ are rejected")',
      sha256: '68121c5f5f2a60cfd813d879030a411b87cae6dab4570e778f716a1c7e3bd5b6',
    },
    covers: ['context-header', 'env-vars'],
    verdict: {
      kind: 'fails',
      code: 'INVALID_ARGS',
      hint: 'Invalid env key "AD_FOO" on line 2: the AD_* namespace is reserved for built-in variables. Rename AD_FOO to avoid the AD_ prefix.',
    },
    note: 'Reserved-namespace refusal shipped with the variable surface itself.',
  },
  {
    id: 'docs/vars-env-after-action@v0.15.1',
    file: 'scripts/docs/vars-env-after-action.v0.15.1.ad',
    recordedBy: 'v0.15.1',
    provenance: {
      kind: 'derived',
      from: 'src/replay/script.ts@v0.15.1 (env ordering guard)',
      sha256: 'e483866a665f952022ceefc35eb97eed87056b52f5cfab7f87849552c47f372d',
    },
    covers: ['context-header', 'env-vars'],
    verdict: {
      kind: 'fails',
      code: 'INVALID_ARGS',
      hint: 'env directives must precede all actions (line 4).',
    },
    note: 'Header-ordering guard for `env`, shipped with the variable surface.',
  },
  {
    id: 'docs/context-header-full@v0.15.1',
    file: 'scripts/docs/context-header-full.v0.15.1.ad',
    recordedBy: 'v0.15.1',
    provenance: {
      kind: 'derived',
      from: 'website/docs/docs/replay-e2e.md@v0.15.1 ("Run a lightweight `.ad` suite")',
      sha256: 'af40bb495926c3c75681921f18ce6a673516279ce64e87225d5dfd04ebb805c4',
    },
    covers: ['context-header', 'wait-landmark', 'quoting'],
    verdict: { kind: 'parses' },
    note: 'Every documented context key on one header: platform, target, timeout, retries.',
  },
  {
    id: 'docs/context-header-conflicting-platform@v0.15.1',
    file: 'scripts/docs/context-header-conflicting-platform.v0.15.1.ad',
    recordedBy: 'v0.15.1',
    provenance: {
      kind: 'derived',
      from: 'website/docs/docs/replay-e2e.md@v0.15.1 ("duplicate keys in the context header fail fast")',
      sha256: '8308e62b032db460546801b173dcad7f28af1a080b824e7eed118dc67b41c039',
    },
    covers: ['context-header'],
    verdict: {
      kind: 'fails',
      code: 'INVALID_ARGS',
      hint: 'Conflicting replay test metadata "platform" in context header: android vs ios.',
    },
    note: 'Documented fail-fast for a conflicting header key.',
  },
  {
    id: 'docs/wait-landmark-forms@v0.20.0',
    file: 'scripts/docs/wait-landmark-forms.v0.20.0.ad',
    recordedBy: 'v0.20.0',
    provenance: {
      kind: 'derived',
      from: 'src/commands/capture/wait-command-contract.ts@v0.20.0 + src/replay/script-utils.ts@v0.20.0',
      sha256: '98501e4372c0ebc1583bf0424792d31872943e5917d84da7db20b042a37292b6',
    },
    covers: ['context-header', 'wait-landmark', 'quoting'],
    verdict: { kind: 'parses' },
    note: 'All released wait kinds a recording can carry: duration, `stable`, selector landmark (#1349), and a generation-pinned `@ref`.',
  },
  {
    id: 'docs/target-v1-annotated-click@v0.20.0',
    file: 'scripts/docs/target-v1-annotated-click.v0.20.0.ad',
    recordedBy: 'v0.20.0',
    provenance: {
      kind: 'derived',
      from: 'docs/adr/0012-interactive-replay.md@v0.20.0 + src/replay/target-identity.ts@v0.20.0',
      sha256: '82a86018ead69e03845e1ff19981ac94cc4f4f90b9a72a5355d110c821e8e67a',
    },
    covers: ['context-header', 'target-annotation', 'quoting'],
    verdict: { kind: 'parses' },
    note: 'ADR 0012 identity annotation bound to its action line.',
  },
  {
    id: 'docs/target-v1-unbound-annotation@v0.20.0',
    file: 'scripts/docs/target-v1-unbound-annotation.v0.20.0.ad',
    recordedBy: 'v0.20.0',
    provenance: {
      kind: 'derived',
      from: 'src/replay/script.ts@v0.20.0 (annotation binding guard)',
      sha256: 'f270fb0ee7757556e3b0f51893a2054360f291693fee6c425c3cf2cf3771aa33',
    },
    covers: ['context-header', 'target-annotation'],
    verdict: {
      kind: 'fails',
      code: 'INVALID_ARGS',
      hint: 'target-v1 annotation on line 4 must be immediately followed by its action line (line 5 is blank).',
    },
    note: 'An annotation separated from its action is a hard parse refusal, not a comment.',
  },
  {
    id: 'docs/gesture-rotate-velocity@v0.16.8',
    file: 'scripts/docs/gesture-rotate-velocity.v0.16.8.ad',
    recordedBy: 'v0.16.8',
    provenance: {
      kind: 'derived',
      from: 'src/commands/cli-grammar/gesture.ts@v0.16.8 (rotateGesturePositionals emitted a trailing velocity)',
      sha256: '5675cc0f4fda8f3b671b2df4c1bafa17b6616fe0add38165a28bb570b3ce03af',
    },
    covers: ['context-header', 'wait-landmark', 'quoting', 'retired-gesture'],
    verdict: {
      kind: 'fails',
      code: 'INVALID_ARGS',
      hint: 'gesture rotate accepts at most 3 arguments: degrees [x] [y] (line 5). The trailing velocity positional was removed: use "gesture rotate 35 195 443"; rotation pacing derives from degrees.',
    },
    note: 'Pre-removal rotate velocity positional as the v0.16.8 recorder wrote it.',
  },
  {
    id: 'docs/gesture-swipe-preset-duration@v0.16.8',
    file: 'scripts/docs/gesture-swipe-preset-duration.v0.16.8.ad',
    recordedBy: 'v0.16.8',
    provenance: {
      kind: 'derived',
      from: 'src/commands/cli-grammar/gesture.ts@v0.16.8 (swipePresetPositionals emitted a trailing durationMs)',
      sha256: '33548361f17388b53ef02655b16a1ca78638b2c2e29035631cba61393a068e0c',
    },
    covers: ['context-header', 'retired-gesture'],
    verdict: {
      kind: 'fails',
      code: 'INVALID_ARGS',
      hint: 'gesture swipe accepts 1 argument: preset (line 4). The trailing durationMs positional was removed: use "gesture swipe up", or gesture pan for timed movement.',
    },
    note: 'Pre-removal `gesture swipe` durationMs positional as the v0.16.8 recorder wrote it.',
  },
  {
    id: 'docs/screenshot-max-size@v0.20.5',
    file: 'scripts/docs/screenshot-max-size.v0.20.5.ad',
    recordedBy: 'v0.20.5',
    provenance: {
      kind: 'derived',
      from: 'packages/contracts/src/screenshot.ts@v0.20.5 (appendScreenshotScriptFlags emitted `--max-size <px>` on recorded screenshot lines)',
      sha256: '1e575d82ae56e0a828a09d220459ae1aab3059076817f1f64dc3cef243f19889',
    },
    covers: ['context-header', 'wait-landmark', 'quoting', 'retired-capture-size'],
    verdict: {
      kind: 'fails',
      code: 'INVALID_ARGS',
      hint: 'screenshot --max-size was removed; use --scale <0.01-1> (or AGENT_DEVICE_SCREENSHOT_SCALE) to downscale proportionally',
    },
    note: 'Pre-removal screenshot `--max-size` flag as the v0.20.5 recorder wrote it. Sole witness of the screenshot sizing migration refusal; without it a parser change could silently demote the flag to ignored positionals and capture at native size.',
  },
  {
    id: 'docs/record-max-size@v0.20.5',
    file: 'scripts/docs/record-max-size.v0.20.5.ad',
    recordedBy: 'v0.20.5',
    provenance: {
      kind: 'derived',
      from: 'packages/ad-script/src/internal/script-utils.ts@v0.20.5 (appendRecordActionScriptArgs emitted `--max-size <px>` between `--fps` and `--quality`)',
      sha256: '882b415a1eb03fedae22526fa48ab6a46cd796d6341aadb0fc783682e2844378',
    },
    covers: ['context-header', 'retired-capture-size'],
    verdict: {
      kind: 'fails',
      code: 'INVALID_ARGS',
      hint: 'record --max-size was removed; recordings capture at native resolution',
    },
    note: 'Pre-removal record `--max-size` flag in the full recorded flag order as the v0.20.5 recorder wrote it. Sole witness of the recording sizing migration refusal.',
  },
];
