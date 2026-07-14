import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import { ANDROID_EMULATOR } from '../../../__tests__/test-utils/index.ts';
import { buildGesturePlan } from '../../../contracts/gesture-plan.ts';
import { AppError } from '../../../kernel/errors.ts';
import { withAndroidAdbProvider } from '../adb-executor.ts';
import { longPressAndroid } from '../input-actions.ts';
import { stopAndroidSnapshotHelperSessionForDevice } from '../snapshot-helper.ts';
import { executeAndroidTouchPlan, readAndroidGestureViewport } from '../touch-executor.ts';
import {
  ANDROID_MULTITOUCH_HELPER_MANIFEST,
  androidMultiTouchResultRecord,
} from './multitouch-helper.fixtures.ts';

vi.mock('../snapshot-helper.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../snapshot-helper.ts')>()),
  stopAndroidSnapshotHelperSessionForDevice: vi.fn(async () => {}),
}));

vi.mock('../helper-package-install.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../helper-package-install.ts')>();
  const fixture = await import('../../../__tests__/test-utils/android-snapshot-helper.ts');
  const multitouchFixture = await import('./multitouch-helper.fixtures.ts');
  return {
    ...actual,
    resolveAndroidHelperArtifact: vi.fn(async () => ({
      apkPath: fixture.ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT.apkPath,
      manifest: {
        ...multitouchFixture.ANDROID_MULTITOUCH_HELPER_MANIFEST,
        sha256: fixture.ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT.manifest.sha256,
      },
    })),
  };
});

const mockStopSnapshotSession = vi.mocked(stopAndroidSnapshotHelperSessionForDevice);
let deviceSequence = 0;

beforeEach(() => {
  mockStopSnapshotSession.mockReset();
});

function makeIsolatedDevice() {
  deviceSequence += 1;
  return { ...ANDROID_EMULATOR, id: `emulator-touch-${deviceSequence}` };
}

test('helper gesture releases persistent snapshot instrumentation before touch instrumentation', async () => {
  const device = makeIsolatedDevice();
  const events: string[] = [];
  mockStopSnapshotSession.mockImplementation(async () => {
    events.push('snapshot-stop');
  });

  const result = await withAndroidAdbProvider(
    {
      exec: async (args) => {
        if (args.includes('--show-versioncode')) {
          return {
            exitCode: 0,
            stdout: `package:${ANDROID_MULTITOUCH_HELPER_MANIFEST.packageName} versionCode:999999`,
            stderr: '',
          };
        }
        if (args.includes('instrument')) {
          events.push('touch-instrumentation');
          return {
            exitCode: 0,
            stdout: [
              androidMultiTouchResultRecord({ ok: 'true', kind: 'swipe' }),
              'INSTRUMENTATION_CODE: 0',
            ].join('\n'),
            stderr: '',
          };
        }
        throw new Error(`unexpected adb call: ${args.join(' ')}`);
      },
    },
    { serial: device.id },
    async () =>
      await executeAndroidTouchPlan(
        device,
        buildGesturePlan(
          {
            intent: 'pan',
            pointerCount: 1,
            origin: { x: 340, y: 400 },
            delta: { x: -280, y: 0 },
            durationMs: 300,
          },
          { x: 0, y: 0, width: 400, height: 800 },
          'android',
        ),
      ),
  );

  assert.equal(result?.backend, 'android-multitouch-helper');
  assert.deepEqual(events, ['snapshot-stop', 'touch-instrumentation']);
});

test('bare-adb long press executes one helper gesture without a viewport probe', async () => {
  const device = makeIsolatedDevice();
  const instrumentCalls: string[][] = [];
  const result = await withAndroidAdbProvider(
    {
      exec: async (args) => {
        if (args.includes('--show-versioncode')) {
          return {
            exitCode: 0,
            stdout: `package:${ANDROID_MULTITOUCH_HELPER_MANIFEST.packageName} versionCode:999999`,
            stderr: '',
          };
        }
        if (args.includes('instrument')) {
          instrumentCalls.push(args);
          return {
            exitCode: 0,
            stdout: [
              androidMultiTouchResultRecord({ ok: 'true', kind: 'swipe' }),
              'INSTRUMENTATION_CODE: 0',
            ].join('\n'),
            stderr: '',
          };
        }
        throw new Error(`unexpected adb call: ${args.join(' ')}`);
      },
    },
    { serial: device.id },
    async () => await longPressAndroid(device, 30, 40, 750),
  );

  assert.equal(result.backend, 'android-multitouch-helper');
  assert.equal(instrumentCalls.length, 1);
  assert.equal(instrumentCalls[0]?.includes('viewport'), false);
  assert.equal(mockStopSnapshotSession.mock.calls.length, 1);
});

test('single-pointer helper failure propagates through the touch executor', async () => {
  const device = makeIsolatedDevice();
  await assert.rejects(
    withAndroidAdbProvider(
      {
        exec: async (args) => {
          if (args.includes('--show-versioncode')) {
            return {
              exitCode: 0,
              stdout: `package:${ANDROID_MULTITOUCH_HELPER_MANIFEST.packageName} versionCode:999999`,
              stderr: '',
            };
          }
          if (args.includes('instrument')) {
            return {
              exitCode: 1,
              stdout: [
                androidMultiTouchResultRecord({
                  ok: 'false',
                  errorType: 'java.lang.IllegalStateException',
                  message: 'injectInputEvent returned false',
                }),
                'INSTRUMENTATION_CODE: 1',
              ].join('\n'),
              stderr: '',
            };
          }
          throw new Error(`unexpected adb call: ${args.join(' ')}`);
        },
      },
      { serial: device.id },
      async () =>
        await executeAndroidTouchPlan(
          device,
          buildGesturePlan(
            {
              intent: 'pan',
              pointerCount: 1,
              origin: { x: 340, y: 400 },
              delta: { x: -280, y: 0 },
              durationMs: 300,
            },
            { x: 0, y: 0, width: 400, height: 800 },
            'android',
          ),
        ),
    ),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'COMMAND_FAILED');
      assert.equal(error.message, 'injectInputEvent returned false');
      assert.equal(error.details?.errorType, 'java.lang.IllegalStateException');
      return true;
    },
  );
});

test('helper viewport failure preserves its structured message and error type', async () => {
  const device = makeIsolatedDevice();
  await assert.rejects(
    withAndroidAdbProvider(
      {
        exec: async (args) => {
          if (args.includes('--show-versioncode')) {
            return {
              exitCode: 0,
              stdout: `package:${ANDROID_MULTITOUCH_HELPER_MANIFEST.packageName} versionCode:999999`,
              stderr: '',
            };
          }
          if (args.includes('instrument')) {
            return {
              exitCode: 1,
              stdout: [
                androidMultiTouchResultRecord({
                  ok: 'false',
                  errorType: 'java.lang.SecurityException',
                  message: 'UiAutomation is unavailable',
                }),
                'INSTRUMENTATION_CODE: 1',
              ].join('\n'),
              stderr: 'instrumentation failed',
            };
          }
          throw new Error(`unexpected adb call: ${args.join(' ')}`);
        },
      },
      { serial: device.id },
      async () => await readAndroidGestureViewport(device),
    ),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'COMMAND_FAILED');
      assert.equal(error.message, 'UiAutomation is unavailable');
      assert.equal(error.details?.errorType, 'java.lang.SecurityException');
      return true;
    },
  );
});
