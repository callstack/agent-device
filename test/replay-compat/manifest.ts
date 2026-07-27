/**
 * The frozen `.ad` replay-compat corpus (#1417): one entry per historical script
 * surface a RELEASED version could have written, paired with the verdict today's
 * parser must return for it.
 *
 * The scripts under `scripts/` are FROZEN. A grammar change that flips a verdict
 * edits the verdict here — never the script — and says why in the same PR. See
 * `README.md`.
 */

import type { AppErrorCode } from '../../src/kernel/errors.ts';

/** `parses`, or the migration refusal the parser owes a script of this vintage. */
export type ReplayCompatVerdict =
  | { kind: 'parses' }
  | { kind: 'fails'; code: AppErrorCode; hint: string };

/** The historical surface an entry exists to hold still. */
export type ReplayCompatCoverage =
  | 'context-header'
  | 'env-vars'
  | 'quoting'
  | 'retired-gesture'
  | 'target-annotation'
  | 'wait-landmark';

export type ReplayCompatEntry = {
  id: string;
  /** Corpus-relative path of the frozen script. */
  file: string;
  /** The released tag whose grammar produced this surface. */
  recordedBy: string;
  /** Where the surface was mined from, at `recordedBy`. */
  source: string;
  covers: ReplayCompatCoverage[];
  verdict: ReplayCompatVerdict;
  /** Why this entry exists, when the path and verdict do not say it. */
  note?: string;
};

/**
 * Mined from the git history of `test/integration/replays` and
 * `examples/test-app/replays` (one entry per distinct content at a release tag),
 * plus surfaces the released grammar wrote that those suites never exercised.
 * Git-history-only grammar states that never shipped are deliberately absent.
 */
export const REPLAY_COMPAT_CORPUS: ReplayCompatEntry[] = [
  {
    id: 'integration/android-01-settings@v0.11.0',
    file: 'scripts/integration/android-01-settings.v0.11.0.ad',
    recordedBy: 'v0.11.0',
    source: 'test/integration/replays/android/01-settings.ad@v0.11.0',
    covers: ['context-header', 'quoting'],
    verdict: { kind: 'parses' },
  },
  {
    id: 'integration/android-01-settings@v0.11.2',
    file: 'scripts/integration/android-01-settings.v0.11.2.ad',
    recordedBy: 'v0.11.2',
    source: 'test/integration/replays/android/01-settings.ad@v0.11.2',
    covers: ['context-header', 'quoting', 'wait-landmark'],
    verdict: { kind: 'parses' },
  },
  {
    id: 'integration/ios-device-01-physical-lifecycle@v0.11.0',
    file: 'scripts/integration/ios-device-01-physical-lifecycle.v0.11.0.ad',
    recordedBy: 'v0.11.0',
    source: 'test/integration/replays/ios/device/01-physical-lifecycle.ad@v0.11.0',
    covers: ['context-header', 'quoting', 'wait-landmark'],
    verdict: { kind: 'parses' },
  },
  {
    id: 'integration/ios-device-01-physical-lifecycle@v0.11.2',
    file: 'scripts/integration/ios-device-01-physical-lifecycle.v0.11.2.ad',
    recordedBy: 'v0.11.2',
    source: 'test/integration/replays/ios/device/01-physical-lifecycle.ad@v0.11.2',
    covers: ['context-header', 'quoting', 'wait-landmark'],
    verdict: { kind: 'parses' },
  },
  {
    id: 'integration/ios-device-01-physical-lifecycle@v0.15.0',
    file: 'scripts/integration/ios-device-01-physical-lifecycle.v0.15.0.ad',
    recordedBy: 'v0.15.0',
    source: 'test/integration/replays/ios/device/01-physical-lifecycle.ad@v0.15.0',
    covers: ['context-header', 'quoting', 'wait-landmark'],
    verdict: { kind: 'parses' },
  },
  {
    id: 'integration/ios-device-01-physical-lifecycle@v0.17.0',
    file: 'scripts/integration/ios-device-01-physical-lifecycle.v0.17.0.ad',
    recordedBy: 'v0.17.0',
    source: 'test/integration/replays/ios/device/01-physical-lifecycle.ad@v0.17.0',
    covers: ['context-header', 'quoting', 'wait-landmark'],
    verdict: { kind: 'parses' },
  },
  {
    id: 'integration/ios-simulator-01-settings@v0.11.0',
    file: 'scripts/integration/ios-simulator-01-settings.v0.11.0.ad',
    recordedBy: 'v0.11.0',
    source: 'test/integration/replays/ios/simulator/01-settings.ad@v0.11.0',
    covers: ['context-header', 'quoting', 'wait-landmark'],
    verdict: { kind: 'parses' },
  },
  {
    id: 'integration/ios-simulator-01-settings@v0.11.2',
    file: 'scripts/integration/ios-simulator-01-settings.v0.11.2.ad',
    recordedBy: 'v0.11.2',
    source: 'test/integration/replays/ios/simulator/01-settings.ad@v0.11.2',
    covers: ['context-header', 'quoting', 'wait-landmark'],
    verdict: { kind: 'parses' },
  },
  {
    id: 'integration/ios-simulator-01-settings@v0.15.0',
    file: 'scripts/integration/ios-simulator-01-settings.v0.15.0.ad',
    recordedBy: 'v0.15.0',
    source: 'test/integration/replays/ios/simulator/01-settings.ad@v0.15.0',
    covers: ['context-header', 'quoting', 'wait-landmark'],
    verdict: { kind: 'parses' },
  },
  {
    id: 'integration/ios-simulator-01-settings@v0.17.0',
    file: 'scripts/integration/ios-simulator-01-settings.v0.17.0.ad',
    recordedBy: 'v0.17.0',
    source: 'test/integration/replays/ios/simulator/01-settings.ad@v0.17.0',
    covers: ['context-header', 'quoting', 'wait-landmark'],
    verdict: { kind: 'parses' },
  },
  {
    id: 'integration/macos-01-system-settings@v0.11.0',
    file: 'scripts/integration/macos-01-system-settings.v0.11.0.ad',
    recordedBy: 'v0.11.0',
    source: 'test/integration/replays/macos/01-system-settings.ad@v0.11.0',
    covers: ['context-header', 'quoting', 'wait-landmark'],
    verdict: { kind: 'parses' },
  },
  {
    id: 'integration/macos-01-system-settings@v0.11.2',
    file: 'scripts/integration/macos-01-system-settings.v0.11.2.ad',
    recordedBy: 'v0.11.2',
    source: 'test/integration/replays/macos/01-system-settings.ad@v0.11.2',
    covers: ['context-header', 'quoting', 'wait-landmark'],
    verdict: { kind: 'parses' },
  },
  {
    id: 'integration/macos-01-system-settings@v0.17.0',
    file: 'scripts/integration/macos-01-system-settings.v0.17.0.ad',
    recordedBy: 'v0.17.0',
    source: 'test/integration/replays/macos/01-system-settings.ad@v0.17.0',
    covers: ['context-header', 'quoting', 'wait-landmark'],
    verdict: { kind: 'parses' },
  },
  {
    id: 'integration/android-02-deep-navigation@v0.11.2',
    file: 'scripts/integration/android-02-deep-navigation.v0.11.2.ad',
    recordedBy: 'v0.11.2',
    source: 'test/integration/replays/android/02-deep-navigation.ad@v0.11.2',
    covers: ['context-header', 'quoting', 'wait-landmark'],
    verdict: { kind: 'parses' },
  },
  {
    id: 'integration/android-02-deep-navigation@v0.12.5',
    file: 'scripts/integration/android-02-deep-navigation.v0.12.5.ad',
    recordedBy: 'v0.12.5',
    source: 'test/integration/replays/android/02-deep-navigation.ad@v0.12.5',
    covers: ['context-header', 'quoting', 'wait-landmark'],
    verdict: { kind: 'parses' },
  },
  {
    id: 'integration/android-03-scroll-discovery@v0.11.2',
    file: 'scripts/integration/android-03-scroll-discovery.v0.11.2.ad',
    recordedBy: 'v0.11.2',
    source: 'test/integration/replays/android/03-scroll-discovery.ad@v0.11.2',
    covers: ['context-header', 'wait-landmark'],
    verdict: { kind: 'parses' },
  },
  {
    id: 'integration/android-04-text-input-keyboard@v0.11.2',
    file: 'scripts/integration/android-04-text-input-keyboard.v0.11.2.ad',
    recordedBy: 'v0.11.2',
    source: 'test/integration/replays/android/04-text-input-keyboard.ad@v0.11.2',
    covers: ['context-header', 'wait-landmark'],
    verdict: { kind: 'parses' },
  },
  {
    id: 'integration/android-05-app-lifecycle@v0.11.2',
    file: 'scripts/integration/android-05-app-lifecycle.v0.11.2.ad',
    recordedBy: 'v0.11.2',
    source: 'test/integration/replays/android/05-app-lifecycle.ad@v0.11.2',
    covers: ['context-header', 'wait-landmark'],
    verdict: { kind: 'parses' },
  },
  {
    id: 'integration/android-06-swipe-gestures@v0.11.2',
    file: 'scripts/integration/android-06-swipe-gestures.v0.11.2.ad',
    recordedBy: 'v0.11.2',
    source: 'test/integration/replays/android/06-swipe-gestures.ad@v0.11.2',
    covers: ['context-header', 'retired-gesture', 'wait-landmark'],
    verdict: {
      kind: 'fails',
      code: 'INVALID_ARGS',
      hint: 'swipe accepts 4 arguments: x1 y1 x2 y2 (line 8). The trailing durationMs positional was removed: use "gesture pan 206 700 0 -450 300" for the same timed drag, or "swipe 206 700 206 250" for a default-duration swipe.',
    },
    note: '#1393 retired the trailing swipe durationMs; a v0.11.2 Android recording carries it and must get the migration, not a silent default-duration swipe.',
  },
  {
    id: 'integration/ios-simulator-02-deep-navigation@v0.11.2',
    file: 'scripts/integration/ios-simulator-02-deep-navigation.v0.11.2.ad',
    recordedBy: 'v0.11.2',
    source: 'test/integration/replays/ios/simulator/02-deep-navigation.ad@v0.11.2',
    covers: ['context-header', 'quoting', 'wait-landmark'],
    verdict: { kind: 'parses' },
  },
  {
    id: 'integration/ios-simulator-02-deep-navigation@v0.15.0',
    file: 'scripts/integration/ios-simulator-02-deep-navigation.v0.15.0.ad',
    recordedBy: 'v0.15.0',
    source: 'test/integration/replays/ios/simulator/02-deep-navigation.ad@v0.15.0',
    covers: ['context-header', 'quoting', 'wait-landmark'],
    verdict: { kind: 'parses' },
  },
  {
    id: 'integration/ios-simulator-02-deep-navigation@v0.17.0',
    file: 'scripts/integration/ios-simulator-02-deep-navigation.v0.17.0.ad',
    recordedBy: 'v0.17.0',
    source: 'test/integration/replays/ios/simulator/02-deep-navigation.ad@v0.17.0',
    covers: ['context-header', 'quoting', 'wait-landmark'],
    verdict: { kind: 'parses' },
  },
  {
    id: 'integration/ios-simulator-03-scroll-discovery@v0.11.2',
    file: 'scripts/integration/ios-simulator-03-scroll-discovery.v0.11.2.ad',
    recordedBy: 'v0.11.2',
    source: 'test/integration/replays/ios/simulator/03-scroll-discovery.ad@v0.11.2',
    covers: ['context-header', 'wait-landmark'],
    verdict: { kind: 'parses' },
  },
  {
    id: 'integration/ios-simulator-03-scroll-discovery@v0.15.0',
    file: 'scripts/integration/ios-simulator-03-scroll-discovery.v0.15.0.ad',
    recordedBy: 'v0.15.0',
    source: 'test/integration/replays/ios/simulator/03-scroll-discovery.ad@v0.15.0',
    covers: ['context-header', 'wait-landmark'],
    verdict: { kind: 'parses' },
  },
  {
    id: 'integration/ios-simulator-04-text-input-keyboard@v0.11.2',
    file: 'scripts/integration/ios-simulator-04-text-input-keyboard.v0.11.2.ad',
    recordedBy: 'v0.11.2',
    source: 'test/integration/replays/ios/simulator/04-text-input-keyboard.ad@v0.11.2',
    covers: ['context-header', 'quoting', 'wait-landmark'],
    verdict: { kind: 'parses' },
  },
  {
    id: 'integration/ios-simulator-04-text-input-keyboard@v0.15.0',
    file: 'scripts/integration/ios-simulator-04-text-input-keyboard.v0.15.0.ad',
    recordedBy: 'v0.15.0',
    source: 'test/integration/replays/ios/simulator/04-text-input-keyboard.ad@v0.15.0',
    covers: ['context-header', 'quoting', 'wait-landmark'],
    verdict: { kind: 'parses' },
  },
  {
    id: 'integration/ios-simulator-05-app-lifecycle@v0.11.2',
    file: 'scripts/integration/ios-simulator-05-app-lifecycle.v0.11.2.ad',
    recordedBy: 'v0.11.2',
    source: 'test/integration/replays/ios/simulator/05-app-lifecycle.ad@v0.11.2',
    covers: ['context-header', 'wait-landmark'],
    verdict: { kind: 'parses' },
  },
  {
    id: 'integration/ios-simulator-05-app-lifecycle@v0.15.0',
    file: 'scripts/integration/ios-simulator-05-app-lifecycle.v0.15.0.ad',
    recordedBy: 'v0.15.0',
    source: 'test/integration/replays/ios/simulator/05-app-lifecycle.ad@v0.15.0',
    covers: ['context-header', 'wait-landmark'],
    verdict: { kind: 'parses' },
  },
  {
    id: 'integration/ios-simulator-06-swipe-gestures@v0.11.2',
    file: 'scripts/integration/ios-simulator-06-swipe-gestures.v0.11.2.ad',
    recordedBy: 'v0.11.2',
    source: 'test/integration/replays/ios/simulator/06-swipe-gestures.ad@v0.11.2',
    covers: ['context-header', 'retired-gesture', 'wait-landmark'],
    verdict: {
      kind: 'fails',
      code: 'INVALID_ARGS',
      hint: 'swipe accepts 4 arguments: x1 y1 x2 y2 (line 6). The trailing durationMs positional was removed: use "gesture pan 197 650 0 -350 300" for the same timed drag, or "swipe 197 650 197 300" for a default-duration swipe.',
    },
  },
  {
    id: 'integration/ios-simulator-06-swipe-gestures@v0.15.0',
    file: 'scripts/integration/ios-simulator-06-swipe-gestures.v0.15.0.ad',
    recordedBy: 'v0.15.0',
    source: 'test/integration/replays/ios/simulator/06-swipe-gestures.ad@v0.15.0',
    covers: ['context-header', 'retired-gesture', 'wait-landmark'],
    verdict: {
      kind: 'fails',
      code: 'INVALID_ARGS',
      hint: 'swipe accepts 4 arguments: x1 y1 x2 y2 (line 6). The trailing durationMs positional was removed: use "gesture pan 197 650 0 -350 300" for the same timed drag, or "swipe 197 650 197 300" for a default-duration swipe.',
    },
  },
  {
    id: 'integration/linux-01-desktop-smoke@v0.11.8',
    file: 'scripts/integration/linux-01-desktop-smoke.v0.11.8.ad',
    recordedBy: 'v0.11.8',
    source: 'test/integration/replays/linux/01-desktop-smoke.ad@v0.11.8',
    covers: ['context-header', 'quoting', 'wait-landmark'],
    verdict: { kind: 'parses' },
  },
  {
    id: 'integration/linux-01-desktop-smoke@v0.15.0',
    file: 'scripts/integration/linux-01-desktop-smoke.v0.15.0.ad',
    recordedBy: 'v0.15.0',
    source: 'test/integration/replays/linux/01-desktop-smoke.ad@v0.15.0',
    covers: ['context-header', 'quoting', 'wait-landmark'],
    verdict: { kind: 'parses' },
  },
  {
    id: 'examples/checkout-form-android@v0.15.1',
    file: 'scripts/examples/checkout-form-android.v0.15.1.ad',
    recordedBy: 'v0.15.1',
    source: 'examples/test-app/replays/checkout-form-android.ad@v0.15.1',
    covers: ['context-header', 'env-vars', 'quoting', 'wait-landmark'],
    verdict: { kind: 'parses' },
  },
  {
    id: 'examples/checkout-form-android@v0.16.8',
    file: 'scripts/examples/checkout-form-android.v0.16.8.ad',
    recordedBy: 'v0.16.8',
    source: 'examples/test-app/replays/checkout-form-android.ad@v0.16.8',
    covers: ['context-header', 'env-vars', 'quoting', 'wait-landmark'],
    verdict: { kind: 'parses' },
  },
  {
    id: 'examples/checkout-form@v0.15.1',
    file: 'scripts/examples/checkout-form.v0.15.1.ad',
    recordedBy: 'v0.15.1',
    source: 'examples/test-app/replays/checkout-form.ad@v0.15.1',
    covers: ['context-header', 'env-vars', 'quoting', 'wait-landmark'],
    verdict: { kind: 'parses' },
  },
  {
    id: 'examples/checkout-form@v0.16.8',
    file: 'scripts/examples/checkout-form.v0.16.8.ad',
    recordedBy: 'v0.16.8',
    source: 'examples/test-app/replays/checkout-form.ad@v0.16.8',
    covers: ['context-header', 'env-vars', 'quoting', 'wait-landmark'],
    verdict: { kind: 'parses' },
  },
  {
    id: 'examples/gesture-lab@v0.16.0',
    file: 'scripts/examples/gesture-lab.v0.16.0.ad',
    recordedBy: 'v0.16.0',
    source: 'examples/test-app/replays/gesture-lab.ad@v0.16.0',
    covers: ['context-header', 'env-vars', 'quoting', 'retired-gesture', 'wait-landmark'],
    verdict: {
      kind: 'fails',
      code: 'INVALID_ARGS',
      hint: 'gesture fling accepts at most 4 arguments: direction x y [distance] (line 15). The trailing durationMs positional was removed: use "gesture fling up 195 443 80", or gesture pan for timed movement.',
    },
    note: '#1393 retired the trailing fling durationMs; the shipped gesture-lab example wrote it until v0.20.0.',
  },
  {
    id: 'examples/gesture-lab@v0.16.8',
    file: 'scripts/examples/gesture-lab.v0.16.8.ad',
    recordedBy: 'v0.16.8',
    source: 'examples/test-app/replays/gesture-lab.ad@v0.16.8',
    covers: ['context-header', 'env-vars', 'quoting', 'retired-gesture', 'wait-landmark'],
    verdict: {
      kind: 'fails',
      code: 'INVALID_ARGS',
      hint: 'gesture fling accepts at most 4 arguments: direction x y [distance] (line 16). The trailing durationMs positional was removed: use "gesture fling up 195 443 80", or gesture pan for timed movement.',
    },
  },
  {
    id: 'examples/gesture-lab@v0.20.0',
    file: 'scripts/examples/gesture-lab.v0.20.0.ad',
    recordedBy: 'v0.20.0',
    source: 'examples/test-app/replays/gesture-lab.ad@v0.20.0',
    covers: ['context-header', 'env-vars', 'quoting', 'wait-landmark'],
    verdict: { kind: 'parses' },
  },
  {
    id: 'examples/gesture-lab-android@v0.20.0',
    file: 'scripts/examples/gesture-lab-android.v0.20.0.ad',
    recordedBy: 'v0.20.0',
    source: 'examples/test-app/replays/gesture-lab-android.ad@v0.20.0',
    covers: ['context-header', 'env-vars', 'quoting', 'wait-landmark'],
    verdict: { kind: 'parses' },
  },
  {
    id: 'docs/vars-parameterized@v0.15.1',
    file: 'scripts/docs/vars-parameterized.v0.15.1.ad',
    recordedBy: 'v0.15.1',
    source: 'website/docs/docs/replay-e2e.md@v0.15.1 ("Parametrise `.ad` scripts")',
    covers: ['context-header', 'env-vars'],
    verdict: { kind: 'parses' },
    note: 'The shipped `${VAR}` surface as documented by the release that introduced it.',
  },
  {
    id: 'docs/vars-quoting-fallback@v0.15.1',
    file: 'scripts/docs/vars-quoting-fallback.v0.15.1.ad',
    recordedBy: 'v0.15.1',
    source:
      'website/docs/docs/replay-e2e.md@v0.15.1 ("Substitution happens inside parsed string values" / "Fallback and escape")',
    covers: ['context-header', 'env-vars', 'quoting', 'wait-landmark'],
    verdict: { kind: 'parses' },
    note: 'Quoted selector values, escaped inner quotes, and `${VAR:-default}` in one script.',
  },
  {
    id: 'docs/record-as-parameterized-fill@v0.15.1',
    file: 'scripts/docs/record-as-parameterized-fill.v0.15.1.ad',
    recordedBy: 'v0.15.1',
    source: 'website/docs/docs/replay-e2e.md@v0.15.1 + src/replay/vars.ts@v0.15.1',
    covers: ['context-header', 'env-vars', 'quoting'],
    verdict: { kind: 'parses' },
    note: '`--record-as` projects a recorded value into exactly this shipped surface: an `env` declaration plus a `${VAR}` fill argument. The flag itself is not in any tag as of the v0.20.0 baseline, so the corpus freezes the released script surface, not the unreleased recorder flag.',
  },
  {
    id: 'docs/vars-reserved-env-key@v0.15.1',
    file: 'scripts/docs/vars-reserved-env-key.v0.15.1.ad',
    recordedBy: 'v0.15.1',
    source:
      'website/docs/docs/replay-e2e.md@v0.15.1 ("User-defined keys starting with AD_ are rejected")',
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
    source: 'src/replay/script.ts@v0.15.1 (env ordering guard)',
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
    source: 'website/docs/docs/replay-e2e.md@v0.15.1 ("Run a lightweight `.ad` suite")',
    covers: ['context-header', 'wait-landmark', 'quoting'],
    verdict: { kind: 'parses' },
    note: 'Every documented context key on one header: platform, target, timeout, retries.',
  },
  {
    id: 'docs/context-header-conflicting-platform@v0.15.1',
    file: 'scripts/docs/context-header-conflicting-platform.v0.15.1.ad',
    recordedBy: 'v0.15.1',
    source:
      'website/docs/docs/replay-e2e.md@v0.15.1 ("duplicate keys in the context header fail fast")',
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
    source:
      'src/commands/capture/wait-command-contract.ts@v0.20.0 + src/replay/script-utils.ts@v0.20.0',
    covers: ['context-header', 'wait-landmark', 'quoting'],
    verdict: { kind: 'parses' },
    note: 'All released wait kinds a recording can carry: duration, `stable`, selector landmark (#1349), and a generation-pinned `@ref`.',
  },
  {
    id: 'docs/target-v1-annotated-click@v0.20.0',
    file: 'scripts/docs/target-v1-annotated-click.v0.20.0.ad',
    recordedBy: 'v0.20.0',
    source: 'docs/adr/0012-interactive-replay.md@v0.20.0 + src/replay/target-identity.ts@v0.20.0',
    covers: ['context-header', 'target-annotation', 'quoting'],
    verdict: { kind: 'parses' },
    note: 'ADR 0012 identity annotation bound to its action line.',
  },
  {
    id: 'docs/target-v1-unbound-annotation@v0.20.0',
    file: 'scripts/docs/target-v1-unbound-annotation.v0.20.0.ad',
    recordedBy: 'v0.20.0',
    source: 'src/replay/script.ts@v0.20.0 (annotation binding guard)',
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
    source:
      'src/commands/cli-grammar/gesture.ts@v0.16.8 (rotateGesturePositionals emitted a trailing velocity)',
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
    source:
      'src/commands/cli-grammar/gesture.ts@v0.16.8 (swipePresetPositionals emitted a trailing durationMs)',
    covers: ['context-header', 'retired-gesture'],
    verdict: {
      kind: 'fails',
      code: 'INVALID_ARGS',
      hint: 'gesture swipe accepts 1 argument: preset (line 4). The trailing durationMs positional was removed: use "gesture swipe up", or gesture pan for timed movement.',
    },
    note: 'Pre-removal `gesture swipe` durationMs positional as the v0.16.8 recorder wrote it.',
  },
];
