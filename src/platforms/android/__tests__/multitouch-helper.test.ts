import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, test } from 'vitest';
import { ANDROID_EMULATOR } from '../../../__tests__/test-utils/index.ts';
import {
  ensureAndroidMultiTouchHelper,
  parseAndroidMultiTouchHelperOutput,
  performGestureAndroid,
  resetAndroidMultiTouchHelperInstallCache,
  rotateGestureAndroid,
  runAndroidMultiTouchHelperGesture,
  swipeGestureAndroid,
} from '../multitouch-helper.ts';
import {
  withAndroidAdbProvider,
  type AndroidAdbExecutor,
  type AndroidAdbProvider,
} from '../adb-executor.ts';
import {
  ANDROID_MULTITOUCH_HELPER_MANIFEST as manifest,
  androidMultiTouchResultRecord as resultRecord,
} from './multitouch-helper.fixtures.ts';
import type { GesturePlan } from '../../../contracts/gesture-plan.ts';

beforeEach(() => {
  resetAndroidMultiTouchHelperInstallCache();
});

test('parseAndroidMultiTouchHelperOutput returns final instrumentation gesture metadata', () => {
  const parsed = parseAndroidMultiTouchHelperOutput(
    [
      resultRecord({
        ok: 'true',
        kind: 'pinch',
        helperApiVersion: '1',
        injectedEvents: '24',
        elapsedMs: '315',
      }),
      'INSTRUMENTATION_CODE: 0',
    ].join('\n'),
  );

  assert.deepEqual(parsed, {
    kind: 'pinch',
    helperApiVersion: '1',
    injectedEvents: 24,
    elapsedMs: 315,
  });
});

test('runAndroidMultiTouchHelperGesture encodes protocol payload for instrumentation', async () => {
  let capturedArgs: string[] | undefined;
  let capturedOptions: Parameters<AndroidAdbExecutor>[1];
  const result = await runAndroidMultiTouchHelperGesture({
    adb: async (args, options) => {
      capturedArgs = args;
      capturedOptions = options;
      return {
        exitCode: 0,
        stdout: [resultRecord({ ok: 'true', kind: 'rotate' }), 'INSTRUMENTATION_CODE: 0'].join(
          '\n',
        ),
        stderr: '',
      };
    },
    request: { kind: 'rotate', x: 100, y: 200, degrees: 145, radius: 120, durationMs: 250 },
    packageName: manifest.packageName,
    instrumentationRunner: manifest.instrumentationRunner,
  });

  assert.equal(result.kind, 'rotate');
  assert.ok(capturedArgs);
  assert.deepEqual(capturedArgs.slice(0, 7), [
    'shell',
    'am',
    'instrument',
    '-w',
    '-e',
    'payloadBase64',
    capturedArgs[6],
  ]);
  assert.deepEqual(JSON.parse(Buffer.from(capturedArgs[6]!, 'base64').toString('utf8')), {
    protocol: 'android-multitouch-helper-v1',
    kind: 'rotate',
    x: 100,
    y: 200,
    degrees: 145,
    radius: 120,
    durationMs: 250,
  });
  assert.equal(capturedArgs.at(-1), manifest.instrumentationRunner);
  assert.equal(capturedOptions?.timeoutMs, 45_000);
});

test('runAndroidMultiTouchHelperGesture encodes one-finger swipe payloads', async () => {
  let capturedPayload: Record<string, unknown> | undefined;
  const result = await runAndroidMultiTouchHelperGesture({
    adb: async (args) => {
      capturedPayload = JSON.parse(Buffer.from(args[6]!, 'base64').toString('utf8'));
      return {
        exitCode: 0,
        stdout: [resultRecord({ ok: 'true', kind: 'swipe' }), 'INSTRUMENTATION_CODE: 0'].join('\n'),
        stderr: '',
      };
    },
    request: { kind: 'swipe', x1: 340, y1: 400, x2: 60, y2: 400, durationMs: 300 },
    packageName: manifest.packageName,
    instrumentationRunner: manifest.instrumentationRunner,
  });

  assert.equal(result.kind, 'swipe');
  assert.deepEqual(capturedPayload, {
    protocol: 'android-multitouch-helper-v1',
    kind: 'swipe',
    x1: 340,
    y1: 400,
    x2: 60,
    y2: 400,
    durationMs: 300,
  });
});

test('runAndroidMultiTouchHelperGesture preserves exact planned pointer samples', async () => {
  let capturedPayload: Record<string, unknown> | undefined;
  await runAndroidMultiTouchHelperGesture({
    adb: async (args) => {
      capturedPayload = JSON.parse(Buffer.from(args[6]!, 'base64').toString('utf8'));
      return {
        exitCode: 0,
        stdout: [resultRecord({ ok: 'true', kind: 'transform' }), 'INSTRUMENTATION_CODE: 0'].join(
          '\n',
        ),
        stderr: '',
      };
    },
    request: {
      kind: 'transform',
      intent: 'pan',
      durationMs: 32,
      pointers: [
        {
          pointerId: 0,
          samples: [
            { offsetMs: 0, x: 100.25, y: 80.5 },
            { offsetMs: 16, x: 110.25, y: 85.5 },
            { offsetMs: 32, x: 120.25, y: 90.5 },
          ],
        },
        {
          pointerId: 1,
          samples: [
            { offsetMs: 0, x: 100.25, y: 120.5 },
            { offsetMs: 16, x: 110.25, y: 125.5 },
            { offsetMs: 32, x: 120.25, y: 130.5 },
          ],
        },
      ],
    },
    packageName: manifest.packageName,
    instrumentationRunner: manifest.instrumentationRunner,
  });

  assert.deepEqual(capturedPayload, {
    protocol: 'android-multitouch-helper-v1',
    kind: 'transform',
    intent: 'pan',
    durationMs: 32,
    pointers: [
      {
        pointerId: 0,
        samples: [
          { offsetMs: 0, x: 100.25, y: 80.5 },
          { offsetMs: 16, x: 110.25, y: 85.5 },
          { offsetMs: 32, x: 120.25, y: 90.5 },
        ],
      },
      {
        pointerId: 1,
        samples: [
          { offsetMs: 0, x: 100.25, y: 120.5 },
          { offsetMs: 16, x: 110.25, y: 125.5 },
          { offsetMs: 32, x: 120.25, y: 130.5 },
        ],
      },
    ],
  });
});

test('performGestureAndroid keeps two-finger pan intent on the provider transform path', async () => {
  const touchCalls: unknown[] = [];
  const plan = twoFingerPanPlan();

  const result = await withAndroidAdbProvider(
    {
      exec: async () => {
        throw new Error('adb should not run when provider touch injection is available');
      },
      touch: async (request) => {
        touchCalls.push(request);
        return { injected: true };
      },
    },
    { serial: ANDROID_EMULATOR.id },
    async () => await performGestureAndroid(ANDROID_EMULATOR, plan),
  );

  assert.deepEqual(result, { backend: 'provider-native-touch', injected: true });
  assert.deepEqual(touchCalls, [
    {
      kind: 'transform',
      x: 100,
      y: 100,
      dx: 20,
      dy: 10,
      scale: 1,
      degrees: 0,
      durationMs: 32,
      intent: 'pan',
      plan,
    },
  ]);
});

test('parseAndroidMultiTouchHelperOutput distinguishes missing final results', () => {
  assert.throws(() => parseAndroidMultiTouchHelperOutput('INSTRUMENTATION_CODE: 0'), {
    code: 'ANDROID_MULTITOUCH_HELPER_NO_FINAL_RESULT',
    message: 'Android multi-touch helper did not return a final result',
  });
});

test('runAndroidMultiTouchHelperGesture preserves helper failure messages', async () => {
  await assert.rejects(
    () =>
      runAndroidMultiTouchHelperGesture({
        adb: async () => ({
          exitCode: 1,
          stdout: [
            resultRecord({
              ok: 'false',
              errorType: 'java.lang.IllegalStateException',
              message: 'injectInputEvent returned false',
            }),
            'INSTRUMENTATION_CODE: 1',
          ].join('\n'),
          stderr: '',
        }),
        request: { kind: 'pinch', x: 100, y: 200, scale: 1.5, radius: 120, durationMs: 250 },
        packageName: manifest.packageName,
        instrumentationRunner: manifest.instrumentationRunner,
      }),
    {
      code: 'COMMAND_FAILED',
      message: 'injectInputEvent returned false',
    },
  );
});

test('swipeGestureAndroid falls back to adb input swipe when helper path is unavailable', async () => {
  const adbCalls: string[][] = [];
  const result = await withAndroidAdbProvider(
    {
      exec: async (args) => {
        adbCalls.push(args);
        if (args.includes('--show-versioncode')) {
          return {
            exitCode: 0,
            stdout: `package:${manifest.packageName} versionCode:999999`,
            stderr: '',
          };
        }
        if (args.includes('instrument')) {
          return {
            exitCode: 1,
            stdout: [
              resultRecord({
                ok: 'false',
                errorType: 'java.lang.IllegalStateException',
                message: 'injectInputEvent returned false',
              }),
              'INSTRUMENTATION_CODE: 1',
            ].join('\n'),
            stderr: '',
          };
        }
        if (args.join(' ') === 'shell input swipe 340 400 60 400 300') {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        throw new Error(`unexpected adb call: ${args.join(' ')}`);
      },
    },
    { serial: ANDROID_EMULATOR.id },
    async () =>
      await swipeGestureAndroid(ANDROID_EMULATOR, {
        x1: 340,
        y1: 400,
        x2: 60,
        y2: 400,
        durationMs: 300,
      }),
  );

  assert.deepEqual(result, { backend: 'adb-input-swipe-fallback' });
  assert.ok(adbCalls.some((args) => args.join(' ') === 'shell input swipe 340 400 60 400 300'));
});

test('swipeGestureAndroid propagates provider-native failures without adb fallback', async () => {
  const adbCalls: string[][] = [];
  await withAndroidAdbProvider(
    {
      exec: async (args) => {
        adbCalls.push(args);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      touch: async () => {
        throw new Error('native touch failed');
      },
    },
    { serial: ANDROID_EMULATOR.id },
    async () => {
      await assert.rejects(
        () =>
          swipeGestureAndroid(ANDROID_EMULATOR, {
            x1: 340,
            y1: 400,
            x2: 60,
            y2: 400,
            durationMs: 300,
          }),
        /native touch failed/,
      );
    },
  );

  assert.deepEqual(adbCalls, []);
});

test('rotateGestureAndroid rejects zero velocity before provider dispatch', async () => {
  await withAndroidAdbProvider(
    {
      exec: async () => {
        throw new Error('adb should not run for invalid input');
      },
      touch: async () => {
        throw new Error('native touch should not run for invalid input');
      },
    },
    { serial: ANDROID_EMULATOR.id },
    async () => {
      await assert.rejects(
        () => rotateGestureAndroid(ANDROID_EMULATOR, { degrees: 90, velocity: 0 }),
        { code: 'INVALID_ARGS' },
      );
    },
  );
});

test('ensureAndroidMultiTouchHelper installs with semantic provider install options', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'multitouch-helper-install-'));
  const apkPath = path.join(tmpDir, 'helper.apk');
  await fs.writeFile(apkPath, 'helper-apk');
  const installCalls: Array<{
    apkPath: string;
    replace?: boolean;
    allowTestPackages?: boolean;
  }> = [];
  const adb: AndroidAdbExecutor = async (args) => {
    if (args.includes('--show-versioncode')) {
      return { exitCode: 1, stdout: '', stderr: 'not found' };
    }
    throw new Error(`unexpected adb call: ${args.join(' ')}`);
  };
  const adbProvider: AndroidAdbProvider = {
    exec: adb,
    install: async (path, options) => {
      installCalls.push({
        apkPath: path,
        replace: options?.replace,
        allowTestPackages: options?.allowTestPackages,
      });
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  };

  const result = await ensureAndroidMultiTouchHelper({
    adb,
    adbProvider,
    artifact: { apkPath, manifest: { ...manifest, sha256: sha256Text('helper-apk') } },
    deviceKey: 'android:emulator-5554',
  });

  assert.equal(result.installed, true);
  assert.equal(result.reason, 'missing');
  assert.deepEqual(installCalls, [{ apkPath, replace: true, allowTestPackages: true }]);
});

function sha256Text(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function twoFingerPanPlan(): Extract<GesturePlan, { topology: 'two' }> {
  return {
    topology: 'two',
    intent: 'pan',
    durationMs: 32,
    viewport: { x: 0, y: 0, width: 400, height: 800 },
    centroid: { start: { x: 100, y: 100 }, end: { x: 120, y: 110 } },
    scale: 1,
    rotationDegrees: 0,
    initialSpan: 40,
    initialAngleDegrees: -90,
    pointers: [
      {
        pointerId: 0,
        samples: [
          { offsetMs: 0, point: { x: 100, y: 80 } },
          { offsetMs: 16, point: { x: 110, y: 85 } },
          { offsetMs: 32, point: { x: 120, y: 90 } },
        ],
      },
      {
        pointerId: 1,
        samples: [
          { offsetMs: 0, point: { x: 100, y: 120 } },
          { offsetMs: 16, point: { x: 110, y: 125 } },
          { offsetMs: 32, point: { x: 120, y: 130 } },
        ],
      },
    ],
  };
}
