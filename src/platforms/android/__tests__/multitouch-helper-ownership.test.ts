import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import { ANDROID_EMULATOR } from '../../../__tests__/test-utils/index.ts';
import { withAndroidAdbProvider } from '../adb-executor.ts';
import {
  resetAndroidMultiTouchHelperInstallCache,
  swipeGestureAndroid,
} from '../multitouch-helper.ts';
import { stopAndroidSnapshotHelperSessionForDevice } from '../snapshot-helper.ts';
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
  const fixture = await import('./android-helper-artifact.fixtures.ts');
  const multitouchFixture = await import('./multitouch-helper.fixtures.ts');
  return {
    ...actual,
    resolveAndroidHelperArtifact: vi.fn(async () => ({
      apkPath: fixture.ANDROID_HELPER_FIXTURE_APK_PATH,
      manifest: {
        ...multitouchFixture.ANDROID_MULTITOUCH_HELPER_MANIFEST,
        sha256: fixture.ANDROID_HELPER_FIXTURE_APK_SHA256,
      },
    })),
  };
});

const mockStopSnapshotSession = vi.mocked(stopAndroidSnapshotHelperSessionForDevice);

beforeEach(() => {
  resetAndroidMultiTouchHelperInstallCache();
  mockStopSnapshotSession.mockReset();
});

test('helper gesture releases persistent snapshot instrumentation before touch instrumentation', async () => {
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

  assert.equal(result?.backend, 'android-multitouch-helper');
  assert.deepEqual(events, ['snapshot-stop', 'touch-instrumentation']);
});
