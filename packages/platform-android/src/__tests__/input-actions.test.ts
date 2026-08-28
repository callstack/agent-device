import { test } from 'vitest';
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
