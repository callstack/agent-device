/**
 * The frozen `.ad` replay-compat corpus (#1417): one entry per historical script
 * surface a RELEASED version wrote, paired with the verdict today's parser must
 * return for it.
 *
 * The scripts under `scripts/` are FROZEN. A grammar change that flips a verdict
 * edits the verdict here — never the script — and says why in the same PR. See
 * `README.md`.
 */

import type { AppErrorCode } from '../../src/kernel/errors.ts';

/**
 * Every release tag the corpus draws from. `pnpm check:replay-compat` verifies
 * each one against `git tag --list`, so an entry cannot claim a version that was
 * never cut.
 */
export const REPLAY_COMPAT_RELEASED_TAGS: readonly string[] = [
  'v0.11.0',
  'v0.11.2',
  'v0.11.8',
  'v0.12.5',
  'v0.15.0',
  'v0.15.1',
  'v0.16.0',
  'v0.16.8',
  'v0.17.0',
  'v0.20.0',
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
    provenance: {
      kind: 'mined',
      path: 'test/integration/replays/android/01-settings.ad',
      blob: 'c91ca3f53082fa1cabcd6df885dd14714d481177',
    },
    covers: ['context-header', 'quoting'],
    verdict: { kind: 'parses' },
  },
  {
    id: 'integration/android-01-settings@v0.11.2',
    file: 'scripts/integration/android-01-settings.v0.11.2.ad',
    recordedBy: 'v0.11.2',
    provenance: {
      kind: 'mined',
      path: 'test/integration/replays/android/01-settings.ad',
      blob: '47b9ff049772143e1bd8b0cd2e64cb381a48ae2d',
    },
    covers: ['context-header', 'quoting', 'wait-landmark'],
    verdict: { kind: 'parses' },
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
  },
  {
    id: 'integration/ios-device-01-physical-lifecycle@v0.11.2',
    file: 'scripts/integration/ios-device-01-physical-lifecycle.v0.11.2.ad',
    recordedBy: 'v0.11.2',
    provenance: {
      kind: 'mined',
      path: 'test/integration/replays/ios/device/01-physical-lifecycle.ad',
      blob: '797de36dc0d5c5aa2287176de72e82a3ccb21bff',
    },
    covers: ['context-header', 'quoting', 'wait-landmark'],
    verdict: { kind: 'parses' },
  },
  {
    id: 'integration/ios-device-01-physical-lifecycle@v0.15.0',
    file: 'scripts/integration/ios-device-01-physical-lifecycle.v0.15.0.ad',
    recordedBy: 'v0.15.0',
    provenance: {
      kind: 'mined',
      path: 'test/integration/replays/ios/device/01-physical-lifecycle.ad',
      blob: '7a5ea2f64756b5400f1e987a32d78b058734461c',
    },
    covers: ['context-header', 'quoting', 'wait-landmark'],
    verdict: { kind: 'parses' },
  },
  {
    id: 'integration/ios-device-01-physical-lifecycle@v0.17.0',
    file: 'scripts/integration/ios-device-01-physical-lifecycle.v0.17.0.ad',
    recordedBy: 'v0.17.0',
    provenance: {
      kind: 'mined',
      path: 'test/integration/replays/ios/device/01-physical-lifecycle.ad',
      blob: 'fb6e1c0b90d331a5c7075f37f6690412d0c926f4',
    },
    covers: ['context-header', 'quoting', 'wait-landmark'],
    verdict: { kind: 'parses' },
  },
  {
    id: 'integration/ios-simulator-01-settings@v0.11.0',
    file: 'scripts/integration/ios-simulator-01-settings.v0.11.0.ad',
    recordedBy: 'v0.11.0',
    provenance: {
      kind: 'mined',
      path: 'test/integration/replays/ios/simulator/01-settings.ad',
      blob: '704f28b6d38dadf820a658320dca4c611ea9684d',
    },
    covers: ['context-header', 'quoting', 'wait-landmark'],
    verdict: { kind: 'parses' },
  },
  {
    id: 'integration/ios-simulator-01-settings@v0.11.2',
    file: 'scripts/integration/ios-simulator-01-settings.v0.11.2.ad',
    recordedBy: 'v0.11.2',
    provenance: {
      kind: 'mined',
      path: 'test/integration/replays/ios/simulator/01-settings.ad',
      blob: 'b9482558fcde1f424dfba55a5dd4dfaecddb7bb4',
    },
    covers: ['context-header', 'quoting', 'wait-landmark'],
    verdict: { kind: 'parses' },
  },
  {
    id: 'integration/ios-simulator-01-settings@v0.15.0',
    file: 'scripts/integration/ios-simulator-01-settings.v0.15.0.ad',
    recordedBy: 'v0.15.0',
    provenance: {
      kind: 'mined',
      path: 'test/integration/replays/ios/simulator/01-settings.ad',
      blob: 'f34cb81707b2a8022d466e0ac2b45fcd43f4dcc7',
    },
    covers: ['context-header', 'quoting', 'wait-landmark'],
    verdict: { kind: 'parses' },
  },
  {
    id: 'integration/ios-simulator-01-settings@v0.17.0',
    file: 'scripts/integration/ios-simulator-01-settings.v0.17.0.ad',
    recordedBy: 'v0.17.0',
    provenance: {
      kind: 'mined',
      path: 'test/integration/replays/ios/simulator/01-settings.ad',
      blob: '418401db198bdb8b96ed80a25d1474effa693d35',
    },
    covers: ['context-header', 'quoting', 'wait-landmark'],
    verdict: { kind: 'parses' },
  },
  {
    id: 'integration/macos-01-system-settings@v0.11.0',
    file: 'scripts/integration/macos-01-system-settings.v0.11.0.ad',
    recordedBy: 'v0.11.0',
    provenance: {
      kind: 'mined',
      path: 'test/integration/replays/macos/01-system-settings.ad',
      blob: 'e3f7f39b53d9a56a14a233129b54f9f110640836',
    },
    covers: ['context-header', 'quoting', 'wait-landmark'],
    verdict: { kind: 'parses' },
  },
  {
    id: 'integration/macos-01-system-settings@v0.11.2',
    file: 'scripts/integration/macos-01-system-settings.v0.11.2.ad',
    recordedBy: 'v0.11.2',
    provenance: {
      kind: 'mined',
      path: 'test/integration/replays/macos/01-system-settings.ad',
      blob: '7df54a82235767e42355b204406421d02bae122b',
    },
    covers: ['context-header', 'quoting', 'wait-landmark'],
    verdict: { kind: 'parses' },
  },
  {
    id: 'integration/macos-01-system-settings@v0.17.0',
    file: 'scripts/integration/macos-01-system-settings.v0.17.0.ad',
    recordedBy: 'v0.17.0',
    provenance: {
      kind: 'mined',
      path: 'test/integration/replays/macos/01-system-settings.ad',
      blob: 'd43f790938cbde47f99e135737589002f014193f',
    },
    covers: ['context-header', 'quoting', 'wait-landmark'],
    verdict: { kind: 'parses' },
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
  },
  {
    id: 'integration/android-02-deep-navigation@v0.12.5',
    file: 'scripts/integration/android-02-deep-navigation.v0.12.5.ad',
    recordedBy: 'v0.12.5',
    provenance: {
      kind: 'mined',
      path: 'test/integration/replays/android/02-deep-navigation.ad',
      blob: '2072595e8e03f76662af0f7dba34d8d7f6a0333f',
    },
    covers: ['context-header', 'quoting', 'wait-landmark'],
    verdict: { kind: 'parses' },
  },
  {
    id: 'integration/android-03-scroll-discovery@v0.11.2',
    file: 'scripts/integration/android-03-scroll-discovery.v0.11.2.ad',
    recordedBy: 'v0.11.2',
    provenance: {
      kind: 'mined',
      path: 'test/integration/replays/android/03-scroll-discovery.ad',
      blob: 'f37427fae15ba0d905bad924585ea898d7ff5985',
    },
    covers: ['context-header', 'wait-landmark'],
    verdict: { kind: 'parses' },
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
    id: 'integration/ios-simulator-02-deep-navigation@v0.11.2',
    file: 'scripts/integration/ios-simulator-02-deep-navigation.v0.11.2.ad',
    recordedBy: 'v0.11.2',
    provenance: {
      kind: 'mined',
      path: 'test/integration/replays/ios/simulator/02-deep-navigation.ad',
      blob: '977f082d918c5ec3999d6e71904331465c1ffa85',
    },
    covers: ['context-header', 'quoting', 'wait-landmark'],
    verdict: { kind: 'parses' },
  },
  {
    id: 'integration/ios-simulator-02-deep-navigation@v0.15.0',
    file: 'scripts/integration/ios-simulator-02-deep-navigation.v0.15.0.ad',
    recordedBy: 'v0.15.0',
    provenance: {
      kind: 'mined',
      path: 'test/integration/replays/ios/simulator/02-deep-navigation.ad',
      blob: 'edc97d2854c813ed4230fe40533628d8ead897bc',
    },
    covers: ['context-header', 'quoting', 'wait-landmark'],
    verdict: { kind: 'parses' },
  },
  {
    id: 'integration/ios-simulator-02-deep-navigation@v0.17.0',
    file: 'scripts/integration/ios-simulator-02-deep-navigation.v0.17.0.ad',
    recordedBy: 'v0.17.0',
    provenance: {
      kind: 'mined',
      path: 'test/integration/replays/ios/simulator/02-deep-navigation.ad',
      blob: '86c27387f4d91e6bfcc5c2a424de41159da68cf5',
    },
    covers: ['context-header', 'quoting', 'wait-landmark'],
    verdict: { kind: 'parses' },
  },
  {
    id: 'integration/ios-simulator-03-scroll-discovery@v0.11.2',
    file: 'scripts/integration/ios-simulator-03-scroll-discovery.v0.11.2.ad',
    recordedBy: 'v0.11.2',
    provenance: {
      kind: 'mined',
      path: 'test/integration/replays/ios/simulator/03-scroll-discovery.ad',
      blob: '898bf8423074fc3e8fb05c1dfef8f1c674eb0529',
    },
    covers: ['context-header', 'wait-landmark'],
    verdict: { kind: 'parses' },
  },
  {
    id: 'integration/ios-simulator-03-scroll-discovery@v0.15.0',
    file: 'scripts/integration/ios-simulator-03-scroll-discovery.v0.15.0.ad',
    recordedBy: 'v0.15.0',
    provenance: {
      kind: 'mined',
      path: 'test/integration/replays/ios/simulator/03-scroll-discovery.ad',
      blob: '2646c29e9b2323d4652a72c74ceeb1c88f49ce75',
    },
    covers: ['context-header', 'wait-landmark'],
    verdict: { kind: 'parses' },
  },
  {
    id: 'integration/ios-simulator-04-text-input-keyboard@v0.11.2',
    file: 'scripts/integration/ios-simulator-04-text-input-keyboard.v0.11.2.ad',
    recordedBy: 'v0.11.2',
    provenance: {
      kind: 'mined',
      path: 'test/integration/replays/ios/simulator/04-text-input-keyboard.ad',
      blob: '0a8be87e3e2caacdf6b35820bb16cc3d492c8fea',
    },
    covers: ['context-header', 'quoting', 'wait-landmark'],
    verdict: { kind: 'parses' },
  },
  {
    id: 'integration/ios-simulator-04-text-input-keyboard@v0.15.0',
    file: 'scripts/integration/ios-simulator-04-text-input-keyboard.v0.15.0.ad',
    recordedBy: 'v0.15.0',
    provenance: {
      kind: 'mined',
      path: 'test/integration/replays/ios/simulator/04-text-input-keyboard.ad',
      blob: 'a9f04c26d8ff91ae705bfa2b4f0c61c0b35b8dd3',
    },
    covers: ['context-header', 'quoting', 'wait-landmark'],
    verdict: { kind: 'parses' },
  },
  {
    id: 'integration/ios-simulator-05-app-lifecycle@v0.11.2',
    file: 'scripts/integration/ios-simulator-05-app-lifecycle.v0.11.2.ad',
    recordedBy: 'v0.11.2',
    provenance: {
      kind: 'mined',
      path: 'test/integration/replays/ios/simulator/05-app-lifecycle.ad',
      blob: '75cb3ca578c93146731676fb4d0bbf8d71b4e6a9',
    },
    covers: ['context-header', 'wait-landmark'],
    verdict: { kind: 'parses' },
  },
  {
    id: 'integration/ios-simulator-05-app-lifecycle@v0.15.0',
    file: 'scripts/integration/ios-simulator-05-app-lifecycle.v0.15.0.ad',
    recordedBy: 'v0.15.0',
    provenance: {
      kind: 'mined',
      path: 'test/integration/replays/ios/simulator/05-app-lifecycle.ad',
      blob: '32d2a15f5006169e8578cde608703dd5e630f577',
    },
    covers: ['context-header', 'wait-landmark'],
    verdict: { kind: 'parses' },
  },
  {
    id: 'integration/ios-simulator-06-swipe-gestures@v0.11.2',
    file: 'scripts/integration/ios-simulator-06-swipe-gestures.v0.11.2.ad',
    recordedBy: 'v0.11.2',
    provenance: {
      kind: 'mined',
      path: 'test/integration/replays/ios/simulator/06-swipe-gestures.ad',
      blob: 'ca067860a93fbd1ca976a02401c3d86993cb2028',
    },
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
    provenance: {
      kind: 'mined',
      path: 'test/integration/replays/ios/simulator/06-swipe-gestures.ad',
      blob: '8f892f1c7af020680a4f921c60cbc4e30ebb021f',
    },
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
    provenance: {
      kind: 'mined',
      path: 'test/integration/replays/linux/01-desktop-smoke.ad',
      blob: 'c707cfdb2f172437cfb094d7e9eb7bb98213b450',
    },
    covers: ['context-header', 'quoting', 'wait-landmark'],
    verdict: { kind: 'parses' },
  },
  {
    id: 'integration/linux-01-desktop-smoke@v0.15.0',
    file: 'scripts/integration/linux-01-desktop-smoke.v0.15.0.ad',
    recordedBy: 'v0.15.0',
    provenance: {
      kind: 'mined',
      path: 'test/integration/replays/linux/01-desktop-smoke.ad',
      blob: '1d88b91a84ff6a59ff84c5a5ab79c3c75620543c',
    },
    covers: ['context-header', 'quoting', 'wait-landmark'],
    verdict: { kind: 'parses' },
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
  },
  {
    id: 'examples/checkout-form@v0.15.1',
    file: 'scripts/examples/checkout-form.v0.15.1.ad',
    recordedBy: 'v0.15.1',
    provenance: {
      kind: 'mined',
      path: 'examples/test-app/replays/checkout-form.ad',
      blob: '8bd23afbd93fe7ec8845882faf346509e9e00d3f',
    },
    covers: ['context-header', 'env-vars', 'quoting', 'wait-landmark'],
    verdict: { kind: 'parses' },
  },
  {
    id: 'examples/checkout-form@v0.16.8',
    file: 'scripts/examples/checkout-form.v0.16.8.ad',
    recordedBy: 'v0.16.8',
    provenance: {
      kind: 'mined',
      path: 'examples/test-app/replays/checkout-form.ad',
      blob: '4c89212dfa191309377a538a16b95bafa8d3d754',
    },
    covers: ['context-header', 'env-vars', 'quoting', 'wait-landmark'],
    verdict: { kind: 'parses' },
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
    note: '#1393 retired the trailing fling durationMs; the shipped gesture-lab example wrote it until v0.20.0.',
  },
  {
    id: 'examples/gesture-lab@v0.16.8',
    file: 'scripts/examples/gesture-lab.v0.16.8.ad',
    recordedBy: 'v0.16.8',
    provenance: {
      kind: 'mined',
      path: 'examples/test-app/replays/gesture-lab.ad',
      blob: '2d6b3aee582d6a04b02e6d51a9d8e6769ed65816',
    },
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
    provenance: {
      kind: 'mined',
      path: 'examples/test-app/replays/gesture-lab.ad',
      blob: 'ac3946e335a97237e5d53fbb3fec8472b955b1f6',
    },
    covers: ['context-header', 'env-vars', 'quoting', 'wait-landmark'],
    verdict: { kind: 'parses' },
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
];
