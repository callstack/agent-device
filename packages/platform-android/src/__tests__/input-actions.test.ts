import { afterEach, beforeEach, test, vi } from 'vitest';
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
import { resetAndroidSnapshotHelperSessions } from '../snapshot-helper-session-lifecycle.ts';
import { ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT } from './test-utils/android-snapshot-helper.ts';
import {
  ANDROID_TOUCH_HELPER_MANIFEST as HELPER_MANIFEST,
  androidTouchHelperResultRecord as helperRecord,
} from './touch-helper.fixtures.ts';

// The fake adb provider installs through the production withAndroidAdbProvider
// scope, so `calls` records device-scoped args without a leading `-s <serial>`.

// The keyboard-aware viewport read goes through the snapshot helper rather than a touch provider,
// so the scroll tests below resolve the fixture APK instead of a bundled one.
vi.mock('../helper-package-install.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../helper-package-install.ts')>();
  return {
    ...actual,
    resolveAndroidHelperArtifact: async () => ({
      apkPath: ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT.apkPath,
      manifest: {
        ...HELPER_MANIFEST,
        sha256: ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT.manifest.sha256,
      },
    }),
  };
});

beforeEach(async () => {
  delete process.env.AGENT_DEVICE_ANDROID_SNAPSHOT_HELPER_SESSION;
  await resetAndroidSnapshotHelperSessions();
});

afterEach(async () => {
  delete process.env.AGENT_DEVICE_ANDROID_SNAPSHOT_HELPER_SESSION;
  await resetAndroidSnapshotHelperSessions();
});

/**
 * Answers one helper session: the version probe says "current" so no install is faked, the viewport
 * read reports `window` plus an optional IME window, and the gesture accepts whatever it is given.
 */
function helperRouteAdb(window: {
  x: number;
  y: number;
  width: number;
  height: number;
  keyboard?: { x: number; y: number; width: number; height: number };
}) {
  return (args: string[]) => {
    if (args.includes('--show-versioncode')) {
      return {
        stdout: `package:${HELPER_MANIFEST.packageName} versionCode:999999`,
        stderr: '',
      };
    }
    if (args.includes('viewport')) {
      const { keyboard, ...app } = window;
      return {
        stdout: [
          helperRecord({
            ok: 'true',
            x: String(app.x),
            y: String(app.y),
            width: String(app.width),
            height: String(app.height),
            ...(keyboard
              ? {
                  keyboardX: String(keyboard.x),
                  keyboardY: String(keyboard.y),
                  keyboardWidth: String(keyboard.width),
                  keyboardHeight: String(keyboard.height),
                }
              : {}),
          }),
          'INSTRUMENTATION_CODE: 0',
        ].join('\n'),
        stderr: '',
      };
    }
    if (args[0] === 'shell' && args[1] === 'am') {
      return {
        stdout: [
          helperRecord({ ok: 'true', kind: 'pan', injectedEvents: '18', elapsedMs: '320' }),
          'INSTRUMENTATION_CODE: 0',
        ].join('\n'),
        stderr: '',
      };
    }
    return undefined;
  };
}

const PORTRAIT_WINDOW = { x: 0, y: 0, width: 1080, height: 2280 };
const LOWER_HALF_KEYBOARD = { x: 0, y: 1600, width: 1080, height: 680 };

test('scrollAndroid keeps the swipe above the IME window and names the clipped band', async () => {
  // The full window would place a center-symmetric swipe at y 1140..~1500 — on the keys. Clipping
  // first means the injected path and the reported reference height both stop above the keyboard
  // by the accessory allowance, so a focused field no longer swallows the gesture (#2500).
  await withFakeAdb(
    helperRouteAdb({ ...PORTRAIT_WINDOW, keyboard: LOWER_HALF_KEYBOARD }),
    async ({ device }) => {
      const result = await scrollAndroid(device, 'down', { pixels: 600 });
      const lowest = Math.max(Number(result.y1), Number(result.y2));
      assert.equal(result.keyboardAvoided, true);
      assert.equal(result.keyboardMinY, 1600);
      assert.equal(result.referenceHeight, 1588, 'clipped axis is the band above the allowance');
      assert.equal(result.pixels, 600, 'requested travel fits the clipped band');
      assert.ok(lowest <= 1588, `swipe endpoint ${lowest} landed under the keyboard`);
    },
  );
});

test('scrollAndroid swipes the whole window when no IME window is on screen', async () => {
  await withFakeAdb(helperRouteAdb({ ...PORTRAIT_WINDOW }), async ({ device }) => {
    const result = await scrollAndroid(device, 'down', { pixels: 600 });
    assert.equal('keyboardAvoided' in result, false);
    assert.equal(result.referenceHeight, 2280);
  });
});

test('scrollAndroid refuses rather than flinging into a keyboard that owns the window', async () => {
  // A landscape IME leaves 40px of a 900px window: a swipe there reads as a stuck surface, so the
  // command refuses with its own typed reason instead of the generic no-progress stop.
  await withFakeAdb(
    helperRouteAdb({
      ...PORTRAIT_WINDOW,
      keyboard: { x: 0, y: 120, width: 1080, height: 2160 },
    }),
    async ({ device }) => {
      await assert.rejects(scrollAndroid(device, 'down', { pixels: 600 }), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(
          (error as { details?: { reason?: string } }).details?.reason,
          'scroll_keyboard_occludes_surface',
        );
        return true;
      });
    },
  );
});

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

test.each([undefined, 'inertial'] as const)(
  'scrollAndroid preserves path and duration with %s release',
  async (releaseBehavior) => {
    const touchCalls: Parameters<AndroidTouchInjector>[0][] = [];
    await withAndroidAdbProvider(
      {
        exec: async () => {
          throw new Error('adb must not run');
        },
        gestureViewport: async () => ({ x: 10, y: 20, width: 1080, height: 1920 }),
        touch: async (request) => {
          touchCalls.push(request);
        },
      },
      { serial: ANDROID_EMULATOR.id },
      async () => {
        for (const direction of ['up', 'down', 'left', 'right'] as const) {
          for (const durationMs of [16, 120, 300, 9841, 10000]) {
            await scrollAndroid(ANDROID_EMULATOR, direction, {
              pixels: 240,
              durationMs,
              releaseBehavior,
            });
          }
        }
      },
    );
    for (const touch of touchCalls) {
      const samples = touch.pointers[0]!.samples;
      const start = samples[0]!;
      const end = samples.at(-1)!;
      assert.equal(start.offsetMs, 0);
      assert.equal(end.offsetMs, touch.durationMs);
      const distance = (a: typeof start, b: typeof start) =>
        Math.hypot(b.point.x - a.point.x, b.point.y - a.point.y);
      assert.equal(distance(start, end), 240);
      const velocities = samples
        .slice(1)
        .map(
          (sample, index) =>
            distance(samples[index]!, sample) / (sample.offsetMs - samples[index]!.offsetMs),
        );
      if (releaseBehavior === 'inertial') {
        for (const velocity of velocities) assert.ok(Math.abs(velocity - velocities[0]!) < 1e-8);
        continue;
      }
      const firstMove = samples[1]!;
      assert.ok(
        distance(start, firstMove) <= ((240 * firstMove.offsetMs) / touch.durationMs) * 1.1,
      );
      assert.ok(velocities.at(-1)! < Math.max(...velocities) / 2);
      for (let i = Math.ceil(velocities.length / 2); i < velocities.length; i += 1) {
        assert.ok(velocities[i]! <= velocities[i - 1]! + 1e-8);
      }
    }
  },
);

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

test('a display probe that exits non-zero fails the settle instead of passing as no field', async () => {
  await withFakeAdb(
    (args) =>
      args[1] === 'dumpsys'
        ? { stdout: '', stderr: 'dumpsys: permission denied', exitCode: 1 }
        : undefined,
    async ({ calls, device }) => {
      await assert.rejects(
        setAndroidOrientation(device, 'landscape-left'),
        /orientation landscape-left could not confirm the display rotation: .*exited with code 1/,
      );
      assert.equal(calls.filter((call) => call[1] === 'dumpsys').length, 1);
    },
  );
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
