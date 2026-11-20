// The one rebind-and-retry round a test-IME `fill` may take: which dispatch acknowledgements send
// it back through re-focus, rebind, clear and commit, and which ones end the fill.
import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import type { AppError } from '@agent-device/kernel/errors';

import {
  CLEAR_ACTION,
  INPUT_ACTION,
  androidImeHelperFixtureArtifact,
  androidInputXml,
  helperSelected,
  imeBroadcastAck,
} from './text-input-test-ime.fixtures.ts';

// Same fixture artifact the channel's other tests route through: android/ime-helper/dist is absent
// on a checkout that has not packaged the helper.
vi.mock('../ime-helper.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ime-helper.ts')>();
  return {
    ...actual,
    resolveAndroidImeHelperArtifact: vi.fn(async () => androidImeHelperFixtureArtifact()),
    selectAndroidImeHelperArtifact: vi.fn(async () => androidImeHelperFixtureArtifact()),
  };
});

import './test-utils/android-host-test-setup.ts';
import { ANDROID_EMULATOR } from './test-utils/device-fixtures.ts';
import {
  ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT,
  createAndroidSnapshotHelperExecutor,
} from './test-utils/android-snapshot-helper.ts';
import { fillAndroid } from '../text-input.ts';
import { withAndroidAdbProvider } from '../adb-executor.ts';
import {
  resetAndroidTestImeActivationCacheForTests,
  setAndroidTestImeActiveForTests,
} from '../ime-lifecycle.ts';

afterEach(() => {
  resetAndroidTestImeActivationCacheForTests();
});

test('fillAndroid rebinds when the clear lands and the text then reaches no editor', async () => {
  setAndroidTestImeActiveForTests(ANDROID_EMULATOR, true);
  const state = { currentText: 'old value' };
  const calls: (readonly string[])[] = [];
  let rebound = false;
  const adb = createAndroidSnapshotHelperExecutor({
    exec: async (args) => {
      calls.push(args);
      if (args[1] === 'settings' && args[2] === 'get') return helperSelected(args);
      if (args[1] === 'ime' && args[2] === 'set') rebound = true;
      if (args[1] === 'am' && args[2] === 'broadcast') {
        // The clear reaches the field, then the input session goes away: the text reaches no
        // editor until the rebind gives the focused field a fresh one.
        if (args.includes(INPUT_ACTION) && !rebound) {
          return {
            exitCode: 0,
            stdout: 'Broadcast completed: result=3, data="no-input-connection"\n',
            stderr: '',
          };
        }
        return imeBroadcastAck(args, state);
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    captureXml: () => androidInputXml({ text: state.currentText }),
  });
  const result = await withAndroidAdbProvider(
    { exec: adb, snapshotHelperArtifact: ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT },
    { serial: ANDROID_EMULATOR.id },
    async () => await fillAndroid(ANDROID_EMULATOR, 10, 10, 'new value'),
  );
  assert.equal(result, undefined, 'a verified fill, not unconfirmed evidence');
  assert.equal(state.currentText, 'new value');
  assert.deepEqual(
    calls.filter((args) => args[1] === 'ime').map((args) => args[2]),
    ['disable', 'enable', 'set'],
  );
  assert.equal(calls.filter((args) => args[1] === 'input' && args[2] === 'tap').length, 2);
  assert.equal(calls.filter((args) => args.includes(CLEAR_ACTION)).length, 2);
  assert.equal(calls.filter((args) => args.includes(INPUT_ACTION)).length, 2);
});

test('fillAndroid retries a no-editor text dispatch once and then reports it', async () => {
  setAndroidTestImeActiveForTests(ANDROID_EMULATOR, true);
  const state = { currentText: 'old value' };
  const calls: (readonly string[])[] = [];
  const adb = createAndroidSnapshotHelperExecutor({
    exec: async (args) => {
      calls.push(args);
      if (args[1] === 'settings' && args[2] === 'get') return helperSelected(args);
      if (args[1] === 'am' && args[2] === 'broadcast') {
        // Even the retried dispatch answers that no editor is focused.
        if (args.includes(INPUT_ACTION)) {
          return {
            exitCode: 0,
            stdout: 'Broadcast completed: result=3, data="no-input-connection"\n',
            stderr: '',
          };
        }
        return imeBroadcastAck(args, state);
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    captureXml: () => androidInputXml({ text: state.currentText }),
  });
  await withAndroidAdbProvider(
    { exec: adb, snapshotHelperArtifact: ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT },
    { serial: ANDROID_EMULATOR.id },
    async () => {
      await assert.rejects(
        fillAndroid(ANDROID_EMULATOR, 10, 10, 'new value'),
        (error: AppError) => {
          assert.equal(error.code, 'COMMAND_FAILED');
          assert.equal(error.details?.reason, 'android_ime_helper_dispatch_rejected');
          assert.equal(error.details?.dispatchKind, 'no-input-connection');
          return true;
        },
      );
    },
  );
  assert.equal(state.currentText, '', 'the retry clears before it commits');
  assert.deepEqual(
    calls.filter((args) => args[1] === 'ime').map((args) => args[2]),
    ['disable', 'enable', 'set'],
    'one rebind serves the one retry',
  );
  assert.equal(calls.filter((args) => args[1] === 'input' && args[2] === 'tap').length, 2);
  assert.equal(calls.filter((args) => args.includes(CLEAR_ACTION)).length, 2);
  assert.equal(calls.filter((args) => args.includes(INPUT_ACTION)).length, 2);
});

test('fillAndroid never retries text the helper already acked as committed', async () => {
  setAndroidTestImeActiveForTests(ANDROID_EMULATOR, true);
  const state = { currentText: 'old value' };
  const calls: (readonly string[])[] = [];
  let textDispatches = 0;
  const adb = createAndroidSnapshotHelperExecutor({
    exec: async (args) => {
      calls.push(args);
      if (args[1] === 'settings' && args[2] === 'get') return helperSelected(args);
      if (args[1] === 'am' && args[2] === 'broadcast') {
        if (args.includes(INPUT_ACTION)) {
          textDispatches += 1;
          // The second chunk of oversized text reaches no editor; the first one is in the field.
          if (textDispatches === 2) {
            return {
              exitCode: 0,
              stdout: 'Broadcast completed: result=3, data="no-input-connection"\n',
              stderr: '',
            };
          }
        }
        return imeBroadcastAck(args, state);
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    captureXml: () => androidInputXml({ text: state.currentText }),
  });
  await withAndroidAdbProvider(
    { exec: adb, snapshotHelperArtifact: ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT },
    { serial: ANDROID_EMULATOR.id },
    async () => {
      await assert.rejects(
        // 50_000 ASCII chars exceed the helper's declared 48_000-byte per-broadcast bound.
        fillAndroid(ANDROID_EMULATOR, 10, 10, 'q'.repeat(50_000)),
        (error: AppError) => {
          assert.equal(error.code, 'COMMAND_FAILED');
          assert.equal(error.details?.reason, 'android_ime_helper_dispatch_rejected');
          assert.equal(error.details?.dispatchKind, 'no-input-connection');
          return true;
        },
      );
    },
  );
  assert.equal(
    state.currentText,
    'q'.repeat(48_000),
    'text that provably landed is not the not-yet-bound case the retry exists for',
  );
  assert.deepEqual(
    calls.filter((args) => args[1] === 'ime').map((args) => args[2]),
    [],
  );
  assert.equal(calls.filter((args) => args[1] === 'input' && args[2] === 'tap').length, 1);
  assert.equal(calls.filter((args) => args.includes(CLEAR_ACTION)).length, 1);
  assert.equal(calls.filter((args) => args.includes(INPUT_ACTION)).length, 2);
});
