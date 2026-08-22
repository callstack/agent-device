import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  fillAndroid,
  longPressAndroid,
  scrollAndroid,
  setAndroidOrientation,
  typeAndroid,
} from '../input-actions.ts';
import { assertRejectsAppError } from '../../../__tests__/test-utils/app-error.ts';
import { ANDROID_EMULATOR } from '../../../__tests__/test-utils/device-fixtures.ts';
import {
  ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT,
  androidSnapshotHelperScriptResponse,
} from '../../../__tests__/test-utils/android-snapshot-helper.ts';
import { withFakeAdb } from '../../../__tests__/test-utils/fake-adb.ts';
import { withAndroidAdbProvider, type AndroidTouchInjector } from '../adb-executor.ts';

// The fake adb provider installs through the production withAndroidAdbProvider
// scope, so `calls` records device-scoped args without a leading `-s <serial>`.

test('scrollAndroid plans explicit pixel travel through semantic touch injection', async () => {
  const touchCalls: Parameters<AndroidTouchInjector>[0][] = [];
  const result = await withAndroidAdbProvider(
    {
      exec: async () => {
        throw new Error('adb must not run');
      },
      gestureViewport: async () => ({
        x: 10,
        y: 20,
        width: 1080,
        height: 1920,
      }),
      touch: async (request) => {
        touchCalls.push(request);
        return { injected: true };
      },
    },
    { serial: ANDROID_EMULATOR.id },
    async () =>
      await scrollAndroid(ANDROID_EMULATOR, 'down', {
        pixels: 240,
        durationMs: 120,
      }),
  );

  assert.equal(touchCalls.length, 1);
  const touch = touchCalls[0]!;
  assert.equal(touch.intent, 'pan');
  assert.deepEqual(touch.pointers[0]?.samples[0]?.point, { x: 550, y: 1100 });
  assert.deepEqual(touch.pointers[0]?.samples.at(-1)?.point, {
    x: 550,
    y: 860,
  });
  assert.equal(result.pixels, 240);
  assert.equal(result.durationMs, 120);
  assert.equal(result.referenceWidth, 1090);
  assert.equal(result.referenceHeight, 1940);
  assert.equal(result.x1, 550);
  assert.equal(result.y1, 1100);
  assert.equal(result.x2, 550);
  assert.equal(result.y2, 860);
  assert.equal(result.backend, 'provider-native-touch');
  assert.equal(result.injected, true);
});

test('scrollAndroid accepts sub-frame public durations at the Android planner minimum', async () => {
  const touchCalls: Parameters<AndroidTouchInjector>[0][] = [];
  const results = await withAndroidAdbProvider(
    {
      exec: async () => {
        throw new Error('adb must not run');
      },
      gestureViewport: async () => ({ x: 0, y: 0, width: 1080, height: 1920 }),
      touch: async (request) => {
        touchCalls.push(request);
      },
    },
    { serial: ANDROID_EMULATOR.id },
    async () => {
      const outputs: Record<string, unknown>[] = [];
      for (const durationMs of [0, 15]) {
        outputs.push(await scrollAndroid(ANDROID_EMULATOR, 'down', { durationMs }));
      }
      return outputs;
    },
  );

  assert.deepEqual(
    touchCalls.map((call) => call.durationMs),
    [16, 16],
  );
  assert.deepEqual(
    results.map((result) => result.durationMs),
    [16, 16],
  );
});

test('longPressAndroid sends a stationary semantic touch plan', async () => {
  const touchCalls: Parameters<AndroidTouchInjector>[0][] = [];
  const result = await withAndroidAdbProvider(
    {
      exec: async () => {
        throw new Error('adb must not run');
      },
      gestureViewport: async () => ({ x: 10, y: 20, width: 300, height: 500 }),
      touch: async (request) => {
        touchCalls.push(request);
      },
    },
    { serial: ANDROID_EMULATOR.id },
    async () => await longPressAndroid(ANDROID_EMULATOR, 30, 40, 750),
  );

  assert.deepEqual(touchCalls, [
    {
      topology: 'single',
      intent: 'longPress',
      durationMs: 750,
      viewport: { x: 10, y: 20, width: 300, height: 500 },
      pointers: [
        {
          pointerId: 0,
          samples: [
            { offsetMs: 0, point: { x: 30, y: 40 } },
            { offsetMs: 750, point: { x: 30, y: 40 } },
          ],
        },
      ],
    },
  ]);
  assert.equal(result.backend, 'provider-native-touch');
});

test('setAndroidOrientation locks auto-rotate and sets user rotation', async () => {
  await withFakeAdb(
    () => undefined,
    async ({ calls, device }) => {
      await setAndroidOrientation(device, 'landscape-left');
      assert.deepEqual(calls, [
        ['shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0'],
        ['shell', 'settings', 'put', 'system', 'user_rotation', '1'],
      ]);
    },
  );
});

test('typeAndroid chunks ASCII input text for shell fallback', async () => {
  await withFakeAdb(
    () => undefined,
    async ({ calls, device }) => {
      await typeAndroid(device, 'filed the expense');
      assert.deepEqual(shellInputTextCalls(calls), [
        ['shell', 'input', 'text', 'filed%sth'],
        ['shell', 'input', 'text', 'e%sexpens'],
        ['shell', 'input', 'text', 'e'],
      ]);
    },
  );
});

test('typeAndroid passes shell-sensitive ascii text to adb input text', async () => {
  await withFakeAdb(
    () => undefined,
    async ({ calls, device }) => {
      await typeAndroid(device, 'curtis.layne+test+73kmc@uber.com');
      assert.deepEqual(shellInputTextCalls(calls), [
        ['shell', 'input', 'text', 'curtis.l'],
        ['shell', 'input', 'text', 'ayne+tes'],
        ['shell', 'input', 'text', 't+73kmc@'],
        ['shell', 'input', 'text', 'uber.com'],
      ]);
    },
  );
});

test('typeAndroid preserves percent signs while encoding spaces', async () => {
  await withFakeAdb(
    () => undefined,
    async ({ calls, device }) => {
      await typeAndroid(device, '50% complete');
      assert.deepEqual(shellInputTextCalls(calls), [
        ['shell', 'input', 'text', '50%%scomp'],
        ['shell', 'input', 'text', 'lete'],
      ]);
    },
  );
});

test('typeAndroid sends one character at a time when delay is requested', async () => {
  await withFakeAdb(
    () => undefined,
    async ({ calls, device }) => {
      await typeAndroid(device, 'hey', 1);
      assert.deepEqual(shellInputTextCalls(calls), [
        ['shell', 'input', 'text', 'h'],
        ['shell', 'input', 'text', 'e'],
        ['shell', 'input', 'text', 'y'],
      ]);
    },
  );
});

test('typeAndroid shell-quotes text containing shell metacharacters', async () => {
  await withFakeAdb(
    () => undefined,
    async ({ calls, device }) => {
      await typeAndroid(device, 'otp; echo pwned');
      // The chunk carrying `;` is single-quoted so the device shell cannot
      // re-tokenize it into a second command.
      assert.deepEqual(shellInputTextCalls(calls), [
        ['shell', 'input', 'text', "'otp;%sech'"],
        ['shell', 'input', 'text', 'o%spwned'],
      ]);
    },
  );
});

test('typeAndroid leaves safe text unquoted', async () => {
  await withFakeAdb(
    () => undefined,
    async ({ calls, device }) => {
      await typeAndroid(device, 'hello');
      assert.deepEqual(shellInputTextCalls(calls), [['shell', 'input', 'text', 'hello']]);
    },
  );
});

test('fillAndroid uses chunk-safe shell input and retries when verification still fails', async () => {
  // First `input text` writes a wrong partial value, so attempt 1 fails
  // verification and production retries with the smaller chunk size.
  let state = '';
  let inputTextCount = 0;
  await withFakeAdb(
    (args) => {
      const helperResponse = snapshotHelperResponse(args, () => state);
      if (helperResponse !== undefined) return helperResponse;
      if (isShellInput(args, 'tap')) return undefined;
      if (isShellKeyevent(args, 'KEYCODE_MOVE_END')) return undefined;
      if (isShellKeyevent(args, 'KEYCODE_DEL')) {
        state = '';
        return undefined;
      }
      if (isShellInput(args, 'text')) {
        inputTextCount += 1;
        state = inputTextCount === 1 ? 'curti' : state + (args[3] ?? '');
        return undefined;
      }
      return { stderr: `unexpected args: ${args.join(' ')}`, exitCode: 1 };
    },
    async ({ calls, device }) => {
      await fillAndroid(device, 10, 10, 'curtis.layne+test+73kmc@uber.com');
      assert.equal(
        calls.some((args) => args.join(' ').startsWith('shell cmd clipboard set text')),
        false,
      );
      assert.equal(
        calls.some((args) => args.includes('KEYCODE_PASTE')),
        false,
      );
      assert.ok(shellInputTextCalls(calls).length > 1);
    },
    {
      provider: { snapshotHelperArtifact: ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT },
    },
  );
}, 15_000);

test('fillAndroid keeps delayed typing in typed-input mode', async () => {
  let state = '';
  await withFakeAdb(
    (args) => {
      const helperResponse = snapshotHelperResponse(args, () => state);
      if (helperResponse !== undefined) return helperResponse;
      if (isShellInput(args, 'tap')) return undefined;
      if (isShellKeyevent(args, 'KEYCODE_MOVE_END')) return undefined;
      if (isShellKeyevent(args, 'KEYCODE_DEL')) {
        state = '';
        return undefined;
      }
      if (isShellInput(args, 'text')) {
        state += args[3] ?? '';
        return undefined;
      }
      return { stderr: `unexpected args: ${args.join(' ')}`, exitCode: 1 };
    },
    async ({ calls, device }) => {
      await fillAndroid(device, 10, 10, 'go', 1);
      assert.equal(shellInputTextCalls(calls).length, 2);
      assert.equal(
        calls.some((args) => args.join(' ').startsWith('shell cmd clipboard set text')),
        false,
      );
      assert.equal(
        calls.some((args) => args.includes('KEYCODE_PASTE')),
        false,
      );
    },
    {
      provider: { snapshotHelperArtifact: ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT },
    },
  );
}, 15_000);

test('fillAndroid tolerates delayed React Native text verification', async () => {
  // The first hierarchy dump reports a stale truncated value (React Native
  // committing late); the later stability dumps report the real text.
  let state = '';
  let dumpCount = 0;
  await withFakeAdb(
    (args) => {
      const helperResponse = snapshotHelperResponse(args, () => {
        dumpCount += 1;
        return dumpCount === 1 ? 'sent the updat' : state;
      });
      if (helperResponse !== undefined) return helperResponse;
      if (isShellInput(args, 'tap')) return undefined;
      if (isShellKeyevent(args, 'KEYCODE_MOVE_END')) return undefined;
      if (isShellKeyevent(args, 'KEYCODE_DEL')) {
        state = '';
        return undefined;
      }
      if (isShellInput(args, 'text')) {
        state += (args[3] ?? '').replace(/%s/g, ' ');
        return undefined;
      }
      return { stderr: `unexpected args: ${args.join(' ')}`, exitCode: 1 };
    },
    async ({ device }) => {
      await fillAndroid(device, 10, 10, 'sent the update');
    },
    {
      provider: { snapshotHelperArtifact: ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT },
    },
  );
}, 10_000);

test('typeAndroid reports clear error when unicode input is unsupported', async () => {
  await withFakeAdb(
    (args) => {
      if (args.join(' ').startsWith('shell cmd clipboard set text')) {
        return 'No shell command implementation.';
      }
      if (isShellInput(args, 'text')) {
        return {
          stderr: "Exception occurred while executing 'text':\njava.lang.NullPointerException\n",
          exitCode: 255,
        };
      }
      return { stderr: `unexpected args: ${args.join(' ')}`, exitCode: 1 };
    },
    async ({ device }) => {
      await assertRejectsAppError(() => typeAndroid(device, '很'), {
        code: 'COMMAND_FAILED',
        message: /provider-native text injection/i,
      });
    },
  );
});

function shellInputTextCalls(calls: string[][]): string[][] {
  return calls.filter((args) => isShellInput(args, 'text'));
}

function isShellInput(args: string[], subcommand: 'tap' | 'text'): boolean {
  return args[0] === 'shell' && args[1] === 'input' && args[2] === subcommand;
}

function isShellKeyevent(args: string[], keycode: string): boolean {
  return (
    args[0] === 'shell' && args[1] === 'input' && args[2] === 'keyevent' && args[3] === keycode
  );
}

/**
 * Answers the snapshot-helper version probe and `am instrument` capture with a
 * one-EditText hierarchy holding `resolveText()`, mirroring the PATH-stub
 * helper script this file used before provider injection. Returns undefined for
 * every other invocation so the caller's script keeps handling input actions.
 */
function snapshotHelperResponse(args: string[], resolveText: () => string): string | undefined {
  return androidSnapshotHelperScriptResponse(
    args,
    () =>
      `<?xml version="1.0" encoding="UTF-8"?><hierarchy><node class="android.widget.EditText" text="${resolveText()}" focused="true" bounds="[0,0][200,100]"/></hierarchy>`,
  );
}
