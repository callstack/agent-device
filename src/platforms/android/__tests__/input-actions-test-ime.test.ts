import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';

const PACKAGE = 'com.callstack.agentdevice.imehelper';

// Inject a fixture artifact so the tests never read android/ime-helper/dist from disk (which a
// fresh checkout that hasn't packaged the helper won't have — CI's Coverage job included).
vi.mock('../ime-helper.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ime-helper.ts')>();
  return {
    ...actual,
    resolveAndroidImeHelperArtifact: vi.fn(async () => ({
      apkPath: '/fixture/helper.apk',
      manifest: {
        name: 'android-ime-helper' as const,
        version: '0.0.0',
        assetName: 'helper.apk',
        sha256: 'a'.repeat(64),
        packageName: PACKAGE,
        versionCode: 1,
        serviceComponent: 'com.callstack.agentdevice.imehelper/.TestInputMethodService',
        broadcastProtocol: 'android-ime-helper-v1' as const,
      },
    })),
  };
});

import {
  ANDROID_EMULATOR,
  ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT,
  createAndroidSnapshotHelperExecutor,
} from '../../../__tests__/test-utils/index.ts';
import { fillAndroid, typeAndroid } from '../input-actions.ts';
import { withAndroidAdbProvider, type AndroidAdbExecutor } from '../adb-executor.ts';
import {
  resetAndroidTestImeActivationCacheForTests,
  setAndroidTestImeActiveForTests,
} from '../ime-lifecycle.ts';

afterEach(() => {
  resetAndroidTestImeActivationCacheForTests();
});

// Non-ASCII text now round-trips via the test IME broadcast channel instead of COMMAND_FAILED.

test('typeAndroid routes non-ASCII text through the test IME broadcast channel when active', async () => {
  setAndroidTestImeActiveForTests(ANDROID_EMULATOR, true);
  const calls: string[][] = [];
  await withAndroidAdbProvider(
    async (args) => {
      calls.push(args);
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    { serial: ANDROID_EMULATOR.id },
    async () => {
      // Previously: assertAndroidShellTextSupported('你好世界 😀') would throw COMMAND_FAILED here.
      await typeAndroid(ANDROID_EMULATOR, '你好世界 😀');
    },
  );

  const broadcastCalls = calls.filter((args) => args[0] === 'shell' && args[1] === 'am');
  assert.ok(broadcastCalls.length > 0, 'expected at least one am broadcast call');
  assert.ok(broadcastCalls.every((args) => args[3] === '-p' && args[4] === PACKAGE));
  assert.ok(
    broadcastCalls.some((args) =>
      args.includes('com.callstack.agentdevice.imehelper.ACTION_INPUT_TEXT_B64'),
    ),
  );
  const textIndex = broadcastCalls[0]?.indexOf('text') ?? -1;
  const decoded =
    textIndex >= 0
      ? Buffer.from(broadcastCalls[0]?.[textIndex + 1] ?? '', 'base64').toString('utf8')
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
  const calls: string[][] = [];
  const adb: AndroidAdbExecutor = createAndroidSnapshotHelperExecutor({
    exec: async (args) => {
      calls.push(args);
      if (args[0] === 'shell' && args[1] === 'am' && args[2] === 'broadcast') {
        const action = args[args.indexOf('-a') + 1];
        if (action === 'com.callstack.agentdevice.imehelper.ACTION_CLEAR_TEXT') {
          currentText = '';
        } else if (action === 'com.callstack.agentdevice.imehelper.ACTION_INPUT_TEXT_B64') {
          const textIndex = args.indexOf('text');
          const payload = textIndex >= 0 ? args[textIndex + 1] : undefined;
          currentText += Buffer.from(payload ?? '', 'base64').toString('utf8');
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    captureXml: () => androidInputXml({ text: currentText }),
  });

  await withAndroidAdbProvider(
    { exec: adb, snapshotHelperArtifact: ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT },
    { serial: ANDROID_EMULATOR.id },
    async () => {
      await fillAndroid(ANDROID_EMULATOR, 10, 10, 'Café ☕ 🎉 你好');
    },
  );

  assert.equal(currentText, 'Café ☕ 🎉 你好');
  assert.equal(
    calls.some((args) => args[0] === 'shell' && args[1] === 'input' && args[2] === 'text'),
    false,
    'the ASCII shell input path must not run while the test IME is active',
  );
});

function androidInputXml(options: { text: string }): string {
  return `<?xml version="1.0" encoding="UTF-8"?><hierarchy><node package="com.example" class="android.widget.EditText" text="${options.text}" focused="true" bounds="[0,0][200,100]"/></hierarchy>`;
}
