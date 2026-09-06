import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import {
  backAndroid,
  homeAndroid,
  longPressAndroid,
  pressAndroidEnter,
  pressAndroidTvRemote,
  scrollAndroid,
  setAndroidOrientation,
} from '../input-actions.ts';
import { ANDROID_EMULATOR } from './test-utils/device-fixtures.ts';
import { withFakeAdb } from './test-utils/fake-adb.ts';
import { withAndroidAdbProvider } from '../adb-executor.ts';
import type { AndroidTouchInjector } from '../adb-executor.ts';

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

test('backAndroid presses keyevent 4 (the Android interactor discards `mode`, matching the retired leaf)', async () => {
  await withFakeAdb(
    () => undefined,
    async ({ calls, device }) => {
      await backAndroid(device);
      assert.deepEqual(calls, [['shell', 'input', 'keyevent', '4']]);
    },
  );
});

test('pressAndroidTvRemote sends D-pad keyevents, and --longpress for a positive duration', async () => {
  await withFakeAdb(
    () => undefined,
    async ({ calls, device }) => {
      await pressAndroidTvRemote(device, 'right');
      await pressAndroidTvRemote(device, 'select', 500);
      assert.deepEqual(calls, [
        ['shell', 'input', 'keyevent', 'KEYCODE_DPAD_RIGHT'],
        ['shell', 'input', 'keyevent', '--longpress', 'KEYCODE_DPAD_CENTER'],
      ]);
    },
  );
});

test('homeAndroid presses keyevent 3', async () => {
  await withFakeAdb(
    () => undefined,
    async ({ calls, device }) => {
      await homeAndroid(device);
      assert.deepEqual(calls, [['shell', 'input', 'keyevent', '3']]);
    },
  );
});

test('pressAndroidEnter presses the ENTER keyevent', async () => {
  await withFakeAdb(
    () => undefined,
    async ({ calls, device }) => {
      await pressAndroidEnter(device);
      assert.deepEqual(calls, [['shell', 'input', 'keyevent', 'ENTER']]);
    },
  );
});

// The orientation settle polls at its own interval; the clock is the assertion, not the wait.
vi.mock('@agent-device/host-kit/retry', () => ({ sleep: async () => {} }));

const ORIENTATION_CALLS = [
  ['shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0'],
  ['shell', 'settings', 'put', 'system', 'user_rotation', '1'],
];
const DISPLAY_READ = ['shell', 'dumpsys', 'display'];

function displayReporting(rotations: string[]): (args: string[]) => string | undefined {
  let reads = 0;
  return (args) => {
    if (args[1] !== 'dumpsys') return undefined;
    const rotation = rotations[Math.min(reads, rotations.length - 1)];
    reads += 1;
    return rotation === undefined ? '' : `  mCurrentOrientation=${rotation}\n`;
  };
}

test('setAndroidOrientation locks auto-rotate, sets user rotation, and returns once the display rotated', async () => {
  await withFakeAdb(displayReporting(['0', '0', '1']), async ({ calls, device }) => {
    await setAndroidOrientation(device, 'landscape-left');
    assert.deepEqual(calls, [...ORIENTATION_CALLS, DISPLAY_READ, DISPLAY_READ, DISPLAY_READ]);
  });
});

test('setAndroidOrientation fails when the display never reports the requested rotation', async () => {
  vi.useFakeTimers({ now: 0, toFake: ['Date'] });
  const probeBudgets: number[] = [];
  try {
    await withFakeAdb(
      (args, options) => {
        // Every display read costs wall clock; the display stays where it was.
        if (args[1] === 'dumpsys') {
          probeBudgets.push(options?.timeoutMs ?? -1);
          vi.setSystemTime(Date.now() + 4_000);
        }
        return displayReporting(['0'])(args);
      },
      async ({ calls, device }) => {
        await assert.rejects(setAndroidOrientation(device, 'landscape-left'), (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /orientation landscape-left did not take effect/);
          const details = (error as { details?: Record<string, unknown> }).details ?? {};
          assert.equal(details.requestedRotation, 1);
          assert.equal(details.observedRotation, 0);
          return true;
        });
        assert.ok(calls.filter((call) => call[1] === 'dumpsys').length >= 4);
        // Each probe may use only what is left of the 15s settle budget.
        assert.equal(probeBudgets[0], 15_000);
        for (let index = 1; index < probeBudgets.length; index += 1) {
          assert.ok(probeBudgets[index]! > 0 && probeBudgets[index]! < probeBudgets[index - 1]!);
        }
      },
    );
  } finally {
    vi.useRealTimers();
  }
});

test('a display probe that hangs for the whole budget ends the settle as a failure', async () => {
  vi.useFakeTimers({ now: 0, toFake: ['Date'] });
  try {
    await withFakeAdb(
      (args, options) => {
        if (args[1] !== 'dumpsys') return undefined;
        // The probe blocks until its own timeout, which is the whole remaining budget.
        vi.setSystemTime(Date.now() + (options?.timeoutMs ?? 0));
        return new Error(`adb shell dumpsys display timed out after ${options?.timeoutMs}ms`);
      },
      async ({ calls, device }) => {
        await assert.rejects(
          setAndroidOrientation(device, 'landscape-left'),
          /orientation landscape-left could not confirm the display rotation: adb shell dumpsys display timed out after 15000ms/,
        );
        assert.equal(calls.filter((call) => call[1] === 'dumpsys').length, 1);
        assert.equal(Date.now(), 15_000);
      },
    );
  } finally {
    vi.useRealTimers();
  }
});

test('setAndroidOrientation leaves a display that reports no rotation to the setting', async () => {
  await withFakeAdb(displayReporting([]), async ({ calls, device }) => {
    await setAndroidOrientation(device, 'portrait');
    assert.deepEqual(calls, [
      ['shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0'],
      ['shell', 'settings', 'put', 'system', 'user_rotation', '0'],
      DISPLAY_READ,
    ]);
  });
});
