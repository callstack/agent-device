import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';

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
      broadcastProtocol: 'android-ime-helper-v1' as const,
    },
  });
  return {
    ...actual,
    // Both the bundled resolver and the provider-aware selector answer with this fixture.
    resolveAndroidImeHelperArtifact: vi.fn(async () => artifact()),
    selectAndroidImeHelperArtifact: vi.fn(async () => artifact()),
  };
});

import fs from 'node:fs/promises';
import { ANDROID_EMULATOR } from '../../../__tests__/test-utils/device-fixtures.ts';
import { mkdtempForTest } from '../../../__tests__/test-utils/tmp-dir.ts';
import { flushDiagnosticsToSessionFile, withDiagnosticsScope } from '../../../utils/diagnostics.ts';
import {
  ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT,
  createAndroidSnapshotHelperExecutor,
} from '../../../__tests__/test-utils/android-snapshot-helper.ts';
import { fillAndroid, typeAndroid } from '../text-input.ts';
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

// The device, not this daemon process, decides which IME is active. A previous run (or another
// daemon on the same emulator) can leave the agent-device helper as the active input method with
// nothing in this process's activation cache — the batch channel is still the right channel there.

test('typeAndroid batches ASCII text when the device is already on the helper IME', async () => {
  const calls: string[][] = [];
  await withAndroidAdbProvider(
    async (args) => {
      calls.push(args);
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

  const broadcasts = calls.filter((args) => args[1] === 'am' && args[2] === 'broadcast');
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
  let currentText = 'stale value';
  const calls: string[][] = [];
  const adb: AndroidAdbExecutor = createAndroidSnapshotHelperExecutor({
    exec: async (args) => {
      calls.push(args);
      if (args[1] === 'am' && args[2] === 'broadcast') {
        const action = args[args.indexOf('-a') + 1];
        if (action === 'com.callstack.agentdevice.imehelper.ACTION_CLEAR_TEXT') {
          currentText = '';
        } else if (action === 'com.callstack.agentdevice.imehelper.ACTION_INPUT_TEXT_B64') {
          const textIndex = args.indexOf('text');
          currentText += Buffer.from(args[textIndex + 1] ?? '', 'base64').toString('utf8');
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      return {
        exitCode: 0,
        stdout: args.join(' ') === 'shell dumpsys input_method' ? helperImeInputMethodDump() : '',
        stderr: '',
      };
    },
    captureXml: () => androidInputXml({ text: currentText }),
  });

  await withAndroidAdbProvider(
    { exec: adb, snapshotHelperArtifact: ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT },
    { serial: ANDROID_EMULATOR.id },
    async () => {
      await fillAndroid(ANDROID_EMULATOR, 10, 10, 'filed the expense');
    },
  );

  assert.equal(currentText, 'filed the expense');
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
});

// Unicode is only beyond the *shell* path. Refusing it before reading which IME is active denied
// the broadcast channel to exactly the devices that could serve it: helper active, cache empty.

test('typeAndroid broadcasts Unicode text when the helper IME is active with an empty cache', async () => {
  const calls: string[][] = [];
  const diagnostics = await captureTextInjectionDiagnostics(async () => {
    await withAndroidAdbProvider(
      async (args) => {
        calls.push(args);
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

  const broadcasts = calls.filter((args) => args[1] === 'am' && args[2] === 'broadcast');
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
  let currentText = 'stale value';
  const calls: string[][] = [];
  const adb: AndroidAdbExecutor = createAndroidSnapshotHelperExecutor({
    exec: async (args) => {
      calls.push(args);
      if (args[1] === 'am' && args[2] === 'broadcast') {
        const action = args[args.indexOf('-a') + 1];
        if (action === 'com.callstack.agentdevice.imehelper.ACTION_CLEAR_TEXT') {
          currentText = '';
        } else if (action === 'com.callstack.agentdevice.imehelper.ACTION_INPUT_TEXT_B64') {
          currentText += decodeBroadcastText(args);
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      return {
        exitCode: 0,
        stdout: args.join(' ') === 'shell dumpsys input_method' ? helperImeInputMethodDump() : '',
        stderr: '',
      };
    },
    captureXml: () => androidInputXml({ text: currentText }),
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

  assert.equal(currentText, 'Café ☕ 🎉 你好');
  assert.equal(
    calls.filter((args) => args[1] === 'input' && args[2] === 'text').length,
    0,
    'Unicode must never reach the ASCII-only shell chunker',
  );
  assert.deepEqual(diagnostics, [{ action: 'fill', backend: 'test-ime' }]);
});

test('a third-party active IME keeps ASCII text on the chunked shell path', async () => {
  const calls: string[][] = [];
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

function decodeBroadcastText(args: string[] | undefined): string {
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
