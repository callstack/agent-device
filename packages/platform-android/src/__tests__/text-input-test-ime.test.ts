import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import type { AppError } from '@agent-device/kernel/errors';

const PACKAGE = 'com.callstack.agentdevice.imehelper';

// Inject a fixture artifact so the tests never read android/ime-helper/dist from disk (which a
// fresh checkout that hasn't packaged the helper won't have — CI's Coverage job included).
vi.mock('../ime-helper.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ime-helper.ts')>();
  // Lazy: the factory is hoisted above this file's top-level constants.
  const artifact = () => ({
    apkPath: '/fixture/helper.apk',
    manifest: {
      name: 'android-ime-helper' as const,
      version: '0.0.0',
      assetName: 'helper.apk',
      sha256: 'a'.repeat(64),
      packageName: PACKAGE,
      versionCode: 1,
      serviceComponent: 'com.callstack.agentdevice.imehelper/.TestInputMethodService',
      broadcastProtocol: 'android-ime-helper-v2' as const,
    },
  });
  return {
    ...actual,
    // Both the bundled resolver and the provider-aware selector answer with this fixture.
    resolveAndroidImeHelperArtifact: vi.fn(async () => artifact()),
    selectAndroidImeHelperArtifact: vi.fn(async () => artifact()),
  };
});

import './test-utils/android-host-test-setup.ts';
import fs from 'node:fs/promises';
import { ANDROID_EMULATOR } from './test-utils/device-fixtures.ts';
import { mkdtempForTest } from './test-utils/tmp-dir.ts';
import {
  flushDiagnosticsToSessionFile,
  withDiagnosticsScope,
} from '@agent-device/host-kit/diagnostics';
import {
  ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT,
  createAndroidSnapshotHelperExecutor,
} from './test-utils/android-snapshot-helper.ts';
import { fillAndroid, typeAndroid } from '../text-input.ts';
import { withAndroidAdbProvider, type AndroidAdbExecutor } from '../adb-executor.ts';
import {
  isAndroidTestImeActive,
  resetAndroidTestImeActivationCacheForTests,
  restoreAndroidTestIme,
  setAndroidTestImeActiveForTests,
} from '../ime-lifecycle.ts';
import { fakeImeDeviceAdb, type FakeImeDeviceState } from '../ime-device.fixtures.ts';
import { getAndroidTestImeOwnership } from '../ime-state.ts';
import { resetAndroidImeHelperAckCacheForTests } from '../ime-helper.ts';
import {
  readAndroidTestImeRecoveryMarkers,
  writeAndroidTestImeRecoveryMarker,
} from '../ime-recovery-marker.ts';

afterEach(() => {
  resetAndroidTestImeActivationCacheForTests();
  resetAndroidImeHelperAckCacheForTests();
});

const PROBE_ACTION = 'com.callstack.agentdevice.imehelper.ACTION_PROBE';
const CLEAR_ACTION = 'com.callstack.agentdevice.imehelper.ACTION_CLEAR_TEXT';
const INPUT_ACTION = 'com.callstack.agentdevice.imehelper.ACTION_INPUT_TEXT_B64';

/**
 * Answers `am broadcast` calls the way the v2 helper does on-device: the capability probe with
 * result=100, text/clear dispatches with result=1 and the attempted UTF-16 length — codes and
 * lengths only, never text. Mutates `state.currentText` like a focused field would.
 */
function imeBroadcastAck(
  args: readonly string[],
  state: { currentText: string },
): { exitCode: number; stdout: string; stderr: string } {
  const action = args[args.indexOf('-a') + 1];
  if (action === PROBE_ACTION) {
    return {
      exitCode: 0,
      stdout:
        'Broadcast completed: result=100, data="android-ime-helper-v2", extras: Bundle[mParcelledData.dataSize=116]\n',
      stderr: '',
    };
  }
  if (action === CLEAR_ACTION) {
    state.currentText = '';
    return { exitCode: 0, stdout: 'Broadcast completed: result=1, data="utf16=0"\n', stderr: '' };
  }
  if (action === INPUT_ACTION) {
    const text = decodeBroadcastText(args);
    state.currentText += text;
    return {
      exitCode: 0,
      stdout: `Broadcast completed: result=1, data="utf16=${text.length}"\n`,
      stderr: '',
    };
  }
  return { exitCode: 0, stdout: 'Broadcast completed: result=0\n', stderr: '' };
}

/** Broadcast calls that carried a text/clear action (the probe excluded). */
function dispatchBroadcasts(calls: readonly (readonly string[])[]): readonly (readonly string[])[] {
  return calls.filter(
    (args) =>
      args[1] === 'am' && args[2] === 'broadcast' && args[args.indexOf('-a') + 1] !== PROBE_ACTION,
  );
}

// Non-ASCII text now round-trips via the test IME broadcast channel instead of COMMAND_FAILED.

test('typeAndroid routes non-ASCII text through the test IME broadcast channel when active', async () => {
  setAndroidTestImeActiveForTests(ANDROID_EMULATOR, true);
  const calls: (readonly string[])[] = [];
  await withAndroidAdbProvider(
    async (args) => {
      calls.push(args);
      if (args[0] === 'shell' && args[1] === 'am' && args[2] === 'broadcast') {
        return imeBroadcastAck(args, { currentText: '' });
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    { serial: ANDROID_EMULATOR.id },
    async () => {
      // Previously: assertAndroidShellTextSupported('你好世界 😀') would throw COMMAND_FAILED here.
      await typeAndroid(ANDROID_EMULATOR, '你好世界 😀');
    },
  );

  const broadcastCalls = calls.filter((args) => args[0] === 'shell' && args[1] === 'am');
  assert.ok(
    broadcastCalls.some((args) => args.includes(PROBE_ACTION)),
    'the ack-capability probe must precede any text dispatch',
  );
  assert.ok(broadcastCalls.every((args) => args[3] === '-p' && args[4] === PACKAGE));
  const dispatches = dispatchBroadcasts(calls);
  assert.equal(dispatches.length, 1);
  assert.ok(dispatches[0]?.includes(INPUT_ACTION));
  const textIndex = dispatches[0]?.indexOf('text') ?? -1;
  const decoded =
    textIndex >= 0
      ? Buffer.from(dispatches[0]?.[textIndex + 1] ?? '', 'base64').toString('utf8')
      : '';
  assert.equal(decoded, '你好世界 😀');

  assert.equal(
    calls.some((args) => args[0] === 'shell' && args[1] === 'input' && args[2] === 'text'),
    false,
    'the ASCII shell input path must not run while the test IME is active',
  );
});

test('fillAndroid clears then commits non-ASCII text through the test IME and verifies it', async () => {
  setAndroidTestImeActiveForTests(ANDROID_EMULATOR, true);
  let currentText = '';
  const calls: (readonly string[])[] = [];
  const state = { currentText };
  const adb: AndroidAdbExecutor = createAndroidSnapshotHelperExecutor({
    exec: async (args) => {
      calls.push(args);
      if (args[0] === 'shell' && args[1] === 'am' && args[2] === 'broadcast') {
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
      await fillAndroid(ANDROID_EMULATOR, 10, 10, 'Café ☕ 🎉 你好');
    },
  );
  currentText = state.currentText;

  assert.equal(currentText, 'Café ☕ 🎉 你好');
  assert.equal(
    calls.some((args) => args[0] === 'shell' && args[1] === 'input' && args[2] === 'text'),
    false,
    'the ASCII shell input path must not run while the test IME is active',
  );
  assert.equal(
    calls.filter((args) => args[1] === 'input' && args[2] === 'tap').length,
    1,
    'one focus tap serves both channel resolution and the first helper attempt',
  );
});

// The device, not this daemon process, decides which IME is active. A previous run (or another
// daemon on the same emulator) can leave the agent-device helper as the active input method with
// nothing in this process's activation cache — the batch channel is still the right channel there.

test('typeAndroid batches ASCII text when the device is already on the helper IME', async () => {
  const calls: (readonly string[])[] = [];
  await withAndroidAdbProvider(
    async (args) => {
      calls.push(args);
      if (args[1] === 'am' && args[2] === 'broadcast')
        return imeBroadcastAck(args, { currentText: '' });
      return {
        exitCode: 0,
        stdout: args.join(' ') === 'shell dumpsys input_method' ? helperImeInputMethodDump() : '',
        stderr: '',
      };
    },
    { serial: ANDROID_EMULATOR.id },
    async () => {
      await typeAndroid(ANDROID_EMULATOR, 'filed the expense');
    },
  );

  const broadcasts = dispatchBroadcasts(calls);
  assert.equal(broadcasts.length, 1, 'the whole string should land in one broadcast');
  assert.deepEqual(broadcasts[0]?.slice(3, 5), ['-p', PACKAGE]);
  const textIndex = broadcasts[0]?.indexOf('text') ?? -1;
  assert.equal(
    Buffer.from(broadcasts[0]?.[textIndex + 1] ?? '', 'base64').toString('utf8'),
    'filed the expense',
  );
  assert.equal(
    calls.filter((args) => args[1] === 'input' && args[2] === 'text').length,
    0,
    'shell chunking must not run when the helper IME owns text entry',
  );
});

test('fillAndroid batches ASCII text when the device is already on the helper IME', async () => {
  const state = { currentText: 'stale value' };
  const calls: (readonly string[])[] = [];
  const adb: AndroidAdbExecutor = createAndroidSnapshotHelperExecutor({
    exec: async (args) => {
      calls.push(args);
      if (args[1] === 'am' && args[2] === 'broadcast') {
        return imeBroadcastAck(args, state);
      }
      return {
        exitCode: 0,
        stdout: args.join(' ') === 'shell dumpsys input_method' ? helperImeInputMethodDump() : '',
        stderr: '',
      };
    },
    captureXml: () => androidInputXml({ text: state.currentText }),
  });

  await withAndroidAdbProvider(
    { exec: adb, snapshotHelperArtifact: ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT },
    { serial: ANDROID_EMULATOR.id },
    async () => {
      await fillAndroid(ANDROID_EMULATOR, 10, 10, 'filed the expense');
    },
  );

  assert.equal(state.currentText, 'filed the expense');
  assert.equal(
    calls.filter((args) => args[1] === 'input' && args[2] === 'text').length,
    0,
    'shell chunking must not run when the helper IME owns text entry',
  );
  assert.equal(
    calls.some((args) => args.includes('KEYCODE_DEL')),
    false,
    'the helper clears the field over the broadcast channel, not with delete keyevents',
  );
  assert.equal(
    calls.filter((args) => args[1] === 'input' && args[2] === 'tap').length,
    1,
    'the focus tap that resolved the channel is the first helper attempt’s focus — no second tap',
  );
});

test('the test IME bounds above agree with TestInputMethodService', async () => {
  const java = await fs.readFile(
    new URL(
      '../../../../android/ime-helper/src/main/java/com/callstack/agentdevice/imehelper/TestInputMethodService.java',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(java, /MAX_TEXT_LENGTH = 32_000;/);
  assert.match(java, /encoded\.length\(\) > MAX_TEXT_LENGTH \* 2/);
});

// TestInputMethodService drops a payload over 64,000 Base64 characters and cuts text after 32,000
// UTF-16 units, so a replacement past either bound must be refused before the field is cleared.
test.each([
  { label: 'over the text length', text: 'a'.repeat(32_001), refused: true },
  { label: 'over the Base64 payload', text: '€'.repeat(21_334), refused: true },
  { label: 'at the text length', text: 'a'.repeat(32_000), refused: false },
])('fillAndroid with a replacement $label refused=$refused', async ({ text, refused }) => {
  setAndroidTestImeActiveForTests(ANDROID_EMULATOR, true);
  let currentText = 'stale value';
  const broadcasts: string[] = [];
  const adb: AndroidAdbExecutor = createAndroidSnapshotHelperExecutor({
    exec: async (args) => {
      if (args[1] === 'am' && args[2] === 'broadcast') {
        const action = args[args.indexOf('-a') + 1] ?? '';
        broadcasts.push(action);
        if (action === 'com.callstack.agentdevice.imehelper.ACTION_CLEAR_TEXT') {
          currentText = '';
        } else if (action === 'com.callstack.agentdevice.imehelper.ACTION_INPUT_TEXT_B64') {
          currentText += decodeBroadcastText(args);
        }
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    captureXml: () => androidInputXml({ text: currentText }),
  });

  const outcome = await withAndroidAdbProvider(
    { exec: adb, snapshotHelperArtifact: ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT },
    { serial: ANDROID_EMULATOR.id },
    async () => await fillAndroid(ANDROID_EMULATOR, 10, 10, text).catch((error: unknown) => error),
  );

  if (refused) {
    assert.equal(
      (outcome as AppError | undefined)?.details?.reason,
      'android-test-ime-text-too-large',
    );
    assert.deepEqual(
      broadcasts,
      [],
      'the field must keep its value when the IME cannot carry text',
    );
    assert.equal(currentText, 'stale value');
  } else {
    assert.equal(outcome, undefined);
    assert.equal(currentText, text);
  }
});

test('fillAndroid re-focuses the target when the first helper attempt fails verification', async () => {
  setAndroidTestImeActiveForTests(ANDROID_EMULATOR, true);
  const state = { currentText: 'stale value' };
  let commits = 0;
  const calls: (readonly string[])[] = [];
  const adb: AndroidAdbExecutor = createAndroidSnapshotHelperExecutor({
    exec: async (args) => {
      calls.push(args);
      if (args[1] === 'settings' && args[2] === 'get') return helperSelected(args);
      if (args[1] === 'am' && args[2] === 'broadcast') {
        if (args[args.indexOf('-a') + 1] === INPUT_ACTION) commits += 1;
        return imeBroadcastAck(args, state);
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    // The first commit never lands in the tree — the not-yet-bound InputConnection case the helper
    // retry exists for — so every verification sample keeps showing the stale value until the
    // second attempt's commit.
    captureXml: () => androidInputXml({ text: commits >= 2 ? state.currentText : 'stale value' }),
  });

  await withAndroidAdbProvider(
    { exec: adb, snapshotHelperArtifact: ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT },
    { serial: ANDROID_EMULATOR.id },
    async () => {
      await fillAndroid(ANDROID_EMULATOR, 10, 10, 'filed the expense');
    },
  );

  assert.equal(state.currentText, 'filed the expense');
  assert.deepEqual(
    calls.filter((args) => args[1] === 'ime').map((args) => args[2]),
    ['disable', 'enable', 'set'],
    'a commit that left the field on its old value may have gone to a stale session',
  );
  assert.equal(
    calls.filter((args) => args[1] === 'input' && args[2] === 'tap').length,
    2,
    'the retry attempt must re-focus the target before its clear-and-commit round',
  );
  assert.equal(
    calls.filter((args) => args.includes('com.callstack.agentdevice.imehelper.ACTION_CLEAR_TEXT'))
      .length,
    2,
    'each helper attempt clears before it commits',
  );
});

test('fillAndroid rebinds once when the first clear has no input connection', async () => {
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
        if (args.includes(CLEAR_ACTION) && !rebound) {
          return { exitCode: 0, stdout: 'Broadcast completed: result=3\n', stderr: '' };
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
    async () => await fillAndroid(ANDROID_EMULATOR, 10, 10, 'new value'),
  );
  assert.equal(state.currentText, 'new value');
  assert.deepEqual(
    calls.filter((args) => args[1] === 'ime').map((args) => args[2]),
    ['disable', 'enable', 'set'],
  );
  assert.equal(calls.filter((args) => args[1] === 'input' && args[2] === 'tap').length, 2);
  assert.equal(calls.filter((args) => args.includes(CLEAR_ACTION)).length, 2);
  assert.equal(calls.filter((args) => args.includes(INPUT_ACTION)).length, 1);
});

test.each([true, false])(
  'fillAndroid requires a matching readback after clear refusal (match=%s)',
  async (matches) => {
    setAndroidTestImeActiveForTests(ANDROID_EMULATOR, true);
    const state = { currentText: 'existing value' };
    const requested = matches ? state.currentText : 'replacement';
    const calls: (readonly string[])[] = [];
    const adb = createAndroidSnapshotHelperExecutor({
      exec: async (args) => {
        calls.push(args);
        if (args[1] === 'am' && args[2] === 'broadcast') {
          if (args.includes(CLEAR_ACTION)) {
            return {
              exitCode: 0,
              stdout: 'Broadcast completed: result=2, data="utf16=0"\n',
              stderr: '',
            };
          }
          return imeBroadcastAck(args, state);
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      captureXml: () => androidInputXml({ text: state.currentText }),
    });
    const fill = withAndroidAdbProvider(
      { exec: adb, snapshotHelperArtifact: ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT },
      { serial: ANDROID_EMULATOR.id },
      async () => await fillAndroid(ANDROID_EMULATOR, 10, 10, requested),
    );
    if (matches) {
      assert.equal(await fill, undefined);
    } else {
      await assert.rejects(fill, (error: AppError) => {
        assert.equal(error.details?.dispatchKind, 'commit-returned-false');
        return true;
      });
    }
    assert.equal(state.currentText, 'existing value');
    assert.equal(calls.filter((args) => args.includes(INPUT_ACTION)).length, 0);
  },
);

test.each([true, false])(
  'fillAndroid recovers a cleared field with hint=%s',
  async (hintShowing) => {
    setAndroidTestImeActiveForTests(ANDROID_EMULATOR, true);
    let rebound = false;
    const state = { currentText: 'old name' };
    const calls: (readonly string[])[] = [];
    const adb: AndroidAdbExecutor = createAndroidSnapshotHelperExecutor({
      exec: async (args) => {
        calls.push(args);
        if (args[1] === 'settings' && args[2] === 'get') return helperSelected(args);
        if (args[1] === 'ime' && args[2] === 'set') rebound = true;
        if (args[1] === 'am' && args[2] === 'broadcast') {
          const action = args[args.indexOf('-a') + 1];
          // The clear lands, then the session goes stale and drops the commit until the rebind.
          if (action === INPUT_ACTION && !rebound) {
            const text = decodeBroadcastText(args);
            return {
              exitCode: 0,
              stdout: `Broadcast completed: result=1, data="utf16=${text.length}"\n`,
              stderr: '',
            };
          }
          return imeBroadcastAck(args, state);
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      captureXml: () =>
        state.currentText
          ? androidInputXml({ text: state.currentText })
          : hintShowing
            ? `<?xml version="1.0" encoding="UTF-8"?><hierarchy><node package="com.example" class="android.widget.EditText" text="e.g. Jane" hint="e.g. Jane" hint-showing="true" focused="true" bounds="[0,0][200,100]"/></hierarchy>`
            : androidInputXml({ text: '' }),
    });

    const result = await withAndroidAdbProvider(
      { exec: adb, snapshotHelperArtifact: ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT },
      { serial: ANDROID_EMULATOR.id },
      async () => await fillAndroid(ANDROID_EMULATOR, 10, 10, 'Jane'),
    );

    assert.equal(result, undefined, 'a verified fill, not unconfirmed evidence');
    assert.equal(state.currentText, 'Jane');
    assert.deepEqual(
      calls.filter((args) => args[1] === 'ime').map((args) => args[2]),
      ['disable', 'enable', 'set'],
    );
    const commands = calls.map((args) => `${args[1]} ${args[2]}`);
    assert.ok(commands.lastIndexOf('ime set') < commands.lastIndexOf('input tap'));
  },
);

test('fillAndroid stops on an unconfirmed rebind and leaves the helper for close-time restore', async () => {
  const stateDir = await mkdtempForTest('agent-device-ime-rebind-');
  setAndroidTestImeActiveForTests(ANDROID_EMULATOR, true, stateDir);
  await writeAndroidTestImeRecoveryMarker(stateDir, ANDROID_EMULATOR.id);
  const device: FakeImeDeviceState = {
    settings: new Map([
      ['default_input_method', 'com.callstack.agentdevice.imehelper/.TestInputMethodService'],
      ['agent_device_ime_helper_previous_ime', 'com.samsung/.Keyboard'],
    ]),
    // `settings get` timing out under load: the rebind cannot read back which IME is selected.
    inputMethodReadFails: true,
  };
  const deviceAdb = fakeImeDeviceAdb(device);
  let commits = 0;
  const adb: AndroidAdbExecutor = createAndroidSnapshotHelperExecutor({
    exec: async (args) => {
      if (args[1] === 'settings' || args[1] === 'ime') return await deviceAdb(args);
      if (args[1] === 'am' && args[2] === 'broadcast') {
        if (args.includes(INPUT_ACTION)) commits += 1;
        return imeBroadcastAck(args, { currentText: '' });
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    captureXml: () =>
      `<?xml version="1.0" encoding="UTF-8"?><hierarchy><node package="com.example" class="android.widget.EditText" text="e.g. Jane" hint="e.g. Jane" hint-showing="true" focused="true" bounds="[0,0][200,100]"/></hierarchy>`,
  });

  await withAndroidAdbProvider(
    { exec: adb, snapshotHelperArtifact: ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT },
    { serial: ANDROID_EMULATOR.id },
    async () => {
      await assert.rejects(fillAndroid(ANDROID_EMULATOR, 10, 10, 'Jane'), (error: AppError) => {
        assert.equal(error.code, 'COMMAND_FAILED');
        assert.equal(error.details?.reason, 'android_test_ime_rebind_unconfirmed');
        assert.equal(error.details?.rebindCause, 'read-failed');
        return true;
      });
    },
  );

  assert.equal(commits, 1, 'no commit goes to an IME the rebind could not confirm');
  assert.equal(isAndroidTestImeActive(ANDROID_EMULATOR), true, 'ownership stays with restore');
  assert.equal(
    device.settings.get('agent_device_ime_helper_previous_ime'),
    'com.samsung/.Keyboard',
    'the rebind leaves the durable restore record alone',
  );

  device.inputMethodReadFails = false;
  const restored = await withAndroidAdbProvider(
    { exec: adb, snapshotHelperArtifact: ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT },
    { serial: ANDROID_EMULATOR.id },
    async () => await restoreAndroidTestIme(ANDROID_EMULATOR, { stateDir }),
  );

  assert.equal(restored.reason, 'ok');
  assert.equal(device.settings.get('default_input_method'), 'com.samsung/.Keyboard');
  assert.deepEqual(await readAndroidTestImeRecoveryMarkers(stateDir), []);
});

test('typeAndroid never broadcasts into a helper whose rebind went unconfirmed', async () => {
  setAndroidTestImeActiveForTests(ANDROID_EMULATOR, true);
  const ownership = getAndroidTestImeOwnership(ANDROID_EMULATOR);
  assert.ok(ownership);
  ownership.rebindUnconfirmed = true;
  const device: FakeImeDeviceState = {
    settings: new Map([['default_input_method', 'com.android.inputmethod.latin/.LatinIME']]),
    imeSetFails: true,
  };
  const deviceAdb = fakeImeDeviceAdb(device);
  const broadcasts: (readonly string[])[] = [];

  await withAndroidAdbProvider(
    async (args) => {
      if (args[1] === 'am') {
        broadcasts.push(args);
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      return await deviceAdb(args);
    },
    { serial: ANDROID_EMULATOR.id },
    async () => {
      await assert.rejects(
        typeAndroid(ANDROID_EMULATOR, 'Jane'),
        (error: { code?: string; details?: { reason?: string } }) =>
          error.code === 'COMMAND_FAILED' &&
          error.details?.reason === 'android_test_ime_rebind_unconfirmed',
      );
    },
  );

  assert.deepEqual(broadcasts, []);
  assert.equal(device.settings.get('agent_device_ime_helper_rebind_displaced'), '1');
});

// Unicode is only beyond the *shell* path. Refusing it before reading which IME is active denied
// the broadcast channel to exactly the devices that could serve it: helper active, cache empty.

test('typeAndroid broadcasts Unicode text when the helper IME is active with an empty cache', async () => {
  const calls: (readonly string[])[] = [];
  const diagnostics = await captureTextInjectionDiagnostics(async () => {
    await withAndroidAdbProvider(
      async (args) => {
        calls.push(args);
        if (args[1] === 'am' && args[2] === 'broadcast') {
          return imeBroadcastAck(args, { currentText: '' });
        }
        return {
          exitCode: 0,
          stdout: args.join(' ') === 'shell dumpsys input_method' ? helperImeInputMethodDump() : '',
          stderr: '',
        };
      },
      { serial: ANDROID_EMULATOR.id },
      async () => {
        await typeAndroid(ANDROID_EMULATOR, '你好世界 😀');
      },
    );
  });

  const broadcasts = dispatchBroadcasts(calls);
  assert.equal(broadcasts.length, 1, 'the whole Unicode string should land in one broadcast');
  assert.deepEqual(broadcasts[0]?.slice(3, 5), ['-p', PACKAGE]);
  assert.equal(decodeBroadcastText(broadcasts[0]), '你好世界 😀');
  assert.equal(
    calls.filter((args) => args[1] === 'input' && args[2] === 'text').length,
    0,
    'Unicode must never reach the ASCII-only shell chunker',
  );
  assert.deepEqual(diagnostics, [{ action: 'type', backend: 'test-ime' }]);
});

test('fillAndroid broadcasts Unicode text when the helper IME is active with an empty cache', async () => {
  const state = { currentText: 'stale value' };
  const calls: (readonly string[])[] = [];
  const adb: AndroidAdbExecutor = createAndroidSnapshotHelperExecutor({
    exec: async (args) => {
      calls.push(args);
      if (args[1] === 'am' && args[2] === 'broadcast') {
        return imeBroadcastAck(args, state);
      }
      return {
        exitCode: 0,
        stdout: args.join(' ') === 'shell dumpsys input_method' ? helperImeInputMethodDump() : '',
        stderr: '',
      };
    },
    captureXml: () => androidInputXml({ text: state.currentText }),
  });

  const diagnostics = await captureTextInjectionDiagnostics(async () => {
    await withAndroidAdbProvider(
      { exec: adb, snapshotHelperArtifact: ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT },
      { serial: ANDROID_EMULATOR.id },
      async () => {
        await fillAndroid(ANDROID_EMULATOR, 10, 10, 'Café ☕ 🎉 你好');
      },
    );
  });

  assert.equal(state.currentText, 'Café ☕ 🎉 你好');
  assert.equal(
    calls.filter((args) => args[1] === 'input' && args[2] === 'text').length,
    0,
    'Unicode must never reach the ASCII-only shell chunker',
  );
  assert.deepEqual(diagnostics, [{ action: 'fill', backend: 'test-ime' }]);
});

test('a third-party active IME keeps ASCII text on the chunked shell path', async () => {
  const calls: (readonly string[])[] = [];
  await withAndroidAdbProvider(
    async (args) => {
      calls.push(args);
      return {
        exitCode: 0,
        stdout:
          args.join(' ') === 'shell dumpsys input_method'
            ? [
                'mInputShown=true',
                'mCurMethodId=com.vendor.keyboard/.VendorIme',
                'packageName=com.example.shop',
                'resourceId=com.example.shop:id/search',
                'inputType=0x1',
              ].join('\n')
            : '',
        stderr: '',
      };
    },
    { serial: ANDROID_EMULATOR.id },
    async () => {
      await typeAndroid(ANDROID_EMULATOR, 'filed the expense');
    },
  );

  assert.equal(calls.filter((args) => args[1] === 'am' && args[2] === 'broadcast').length, 0);
  assert.equal(calls.filter((args) => args[1] === 'input' && args[2] === 'text').length, 3);
});

test('typeAndroid splits oversized text into code-point-safe acked chunks instead of truncating', async () => {
  setAndroidTestImeActiveForTests(ANDROID_EMULATOR, true);
  const state = { currentText: '' };
  const calls: (readonly string[])[] = [];
  await withAndroidAdbProvider(
    async (args) => {
      calls.push(args);
      if (args[0] === 'shell' && args[1] === 'am' && args[2] === 'broadcast') {
        return imeBroadcastAck(args, state);
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    { serial: ANDROID_EMULATOR.id },
    async () => {
      // 50_000 ASCII chars exceed the helper's declared 48_000-byte per-broadcast bound.
      await typeAndroid(ANDROID_EMULATOR, 'q'.repeat(50_000) + '😀');
    },
  );

  const dispatches = dispatchBroadcasts(calls);
  assert.equal(
    dispatches.length,
    2,
    'oversized text is dispatched as ordered chunks, not truncated',
  );
  const chunkLengths = dispatches.map((args) =>
    Buffer.byteLength(decodeBroadcastText(args), 'utf8'),
  );
  assert.deepEqual(
    chunkLengths,
    [48_000, 2_004],
    'first chunk fills the byte bound; the emoji stays whole',
  );
  assert.equal(state.currentText, 'q'.repeat(50_000) + '😀');
});

test('typeAndroid reports a partial dispatch truthfully when a later chunk is rejected', async () => {
  setAndroidTestImeActiveForTests(ANDROID_EMULATOR, true);
  const state = { currentText: '' };
  let dispatches = 0;
  await withAndroidAdbProvider(
    async (args) => {
      if (args[0] === 'shell' && args[1] === 'am' && args[2] === 'broadcast') {
        const action = args[args.indexOf('-a') + 1];
        if (action === INPUT_ACTION) {
          dispatches += 1;
          // The second chunk's editor reports no input connection.
          if (dispatches === 2) {
            return {
              exitCode: 0,
              stdout: 'Broadcast completed: result=3, data="no-input-connection"\n',
              stderr: '',
            };
          }
          return imeBroadcastAck(args, state);
        }
        return imeBroadcastAck(args, state);
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    { serial: ANDROID_EMULATOR.id },
    async () => {
      await assert.rejects(typeAndroid(ANDROID_EMULATOR, 'q'.repeat(50_000)), (error: AppError) => {
        assert.equal(error.code, 'COMMAND_FAILED');
        assert.equal(error.details?.failureReason, 'android_ime_helper_dispatch_rejected');
        assert.equal(error.details?.dispatchKind, 'no-input-connection');
        assert.equal(
          error.details?.dispatchedChunks,
          1,
          'partial-dispatch evidence: the first chunk was already dispatched',
        );
        return true;
      });
    },
  );
  assert.equal(dispatches, 2, 'the series stopped at the rejected chunk');
  assert.equal(state.currentText, 'q'.repeat(48_000), 'only the first chunk landed');
});

test('typeAndroid refuses to report success when the running helper never acknowledges', async () => {
  setAndroidTestImeActiveForTests(ANDROID_EMULATOR, true);
  const calls: (readonly string[])[] = [];
  await withAndroidAdbProvider(
    async (args) => {
      calls.push(args);
      // A pre-ack (v1) helper or a dead receiver: result=0 for everything.
      if (args[0] === 'shell' && args[1] === 'am' && args[2] === 'broadcast') {
        return { exitCode: 0, stdout: 'Broadcast completed: result=0\n', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    { serial: ANDROID_EMULATOR.id },
    async () => {
      await assert.rejects(
        typeAndroid(ANDROID_EMULATOR, 'hello'),
        (error: AppError) =>
          error.code === 'COMMAND_FAILED' &&
          error.details?.failureReason === 'android_ime_helper_no_ack',
      );
    },
  );
  assert.equal(
    calls.filter((args) => args.includes(INPUT_ACTION)).length,
    0,
    'no text is dispatched once the ack capability is refused',
  );
});

test('typeAndroid sends KEYCODE_DEL keyevents instead of broadcasting backspaces through the test IME', async () => {
  setAndroidTestImeActiveForTests(ANDROID_EMULATOR, true);
  const calls: (readonly string[])[] = [];
  await withAndroidAdbProvider(
    async (args) => {
      calls.push(args);
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    { serial: ANDROID_EMULATOR.id },
    async () => {
      await typeAndroid(ANDROID_EMULATOR, '\b\b\b');
    },
  );

  assert.equal(calls.filter((args) => args[1] === 'am' && args[2] === 'broadcast').length, 0);
  const delCalls = calls.filter(
    (args) => args[0] === 'shell' && args[1] === 'input' && args[2] === 'keyevent',
  );
  assert.equal(delCalls.length, 1);
  assert.deepEqual(delCalls[0], [
    'shell',
    'input',
    'keyevent',
    'KEYCODE_DEL',
    'KEYCODE_DEL',
    'KEYCODE_DEL',
  ]);
});

/** The `android_text_injection` events a run emitted, in order, as `{action, backend}` pairs. */
async function captureTextInjectionDiagnostics(
  run: () => Promise<void>,
): Promise<Array<{ action: unknown; backend: unknown }>> {
  const previousHome = process.env.HOME;
  process.env.HOME = await mkdtempForTest('agent-device-text-injection-');
  try {
    const path = await withDiagnosticsScope({ session: 'text-injection' }, async () => {
      await run();
      return flushDiagnosticsToSessionFile({ force: true })?.path ?? null;
    });
    assert.ok(path, 'expected a flushed diagnostics file');
    const lines = (await fs.readFile(path, 'utf8')).split('\n').filter(Boolean);
    return lines
      .map((line) => JSON.parse(line) as { phase: string; data?: Record<string, unknown> })
      .filter((event) => event.phase === 'android_text_injection')
      .map((event) => ({ action: event.data?.action, backend: event.data?.backend }));
  } finally {
    process.env.HOME = previousHome;
  }
}

function decodeBroadcastText(args: readonly string[] | undefined): string {
  const textIndex = args?.indexOf('text') ?? -1;
  if (!args || textIndex < 0) return '';
  return Buffer.from(args[textIndex + 1] ?? '', 'base64').toString('utf8');
}

function helperImeInputMethodDump(): string {
  return [
    'mInputShown=true',
    `mCurMethodId=${PACKAGE}/.TestInputMethodService`,
    'packageName=com.example.shop',
    'resourceId=com.example.shop:id/search',
    'inputType=0x1',
  ].join('\n');
}

function androidInputXml(options: { text: string }): string {
  return `<?xml version="1.0" encoding="UTF-8"?><hierarchy><node package="com.example" class="android.widget.EditText" text="${options.text}" focused="true" bounds="[0,0][200,100]"/></hierarchy>`;
}

/** Settings reads after a rebind: its device record reads back, and the helper is still selected. */
function helperSelected(args: readonly string[]) {
  const stdout =
    args[4] === 'agent_device_ime_helper_rebind_displaced'
      ? '1\n'
      : 'com.callstack.agentdevice.imehelper/.TestInputMethodService\n';
  return { exitCode: 0, stdout, stderr: '' };
}
