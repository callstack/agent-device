import { ANDROID_EMULATOR } from '../../../__tests__/test-utils/index.ts';
import { buildGesturePlan } from '../../../contracts/gesture-plan.ts';
import type { DeviceInfo } from '../../../kernel/device.ts';
import type { AndroidAdbExecutor } from '../adb-executor.ts';
import type { AndroidTouchPlan } from '../touch-plan.ts';

// The one-shot touch helper path now runs through the snapshot-helper APK/runner
// (issue #1275 consolidation), so these fixtures mirror the snapshot helper's
// package/protocol identity rather than the retired standalone multitouch helper.
export const ANDROID_TOUCH_HELPER_MANIFEST = {
  name: 'android-snapshot-helper' as const,
  version: '0.17.0',
  assetName: 'helper.apk',
  sha256: 'a'.repeat(64),
  packageName: 'com.callstack.agentdevice.snapshothelper',
  versionCode: 17000,
  instrumentationRunner: 'com.callstack.agentdevice.snapshothelper/.SnapshotInstrumentation',
  statusProtocol: 'android-snapshot-helper-v1' as const,
  installArgs: ['install', '-r', '-t'],
};

export function androidTouchHelperResultRecord(values: Record<string, string>): string {
  return [
    'INSTRUMENTATION_RESULT: agentDeviceProtocol=android-snapshot-helper-v1',
    ...Object.entries(values).map(([key, value]) => `INSTRUMENTATION_RESULT: ${key}=${value}`),
  ].join('\n');
}

// Shared test fixtures used by both touch-helper.test.ts (one-shot normalize/parse/gesture/
// viewport coverage) and touch-helper-session.test.ts (persistent-session transport coverage), so
// the two files stay consistent about device identity, plan shapes, and the install-decision probe.

export const ANDROID_TOUCH_HELPER_VIEWPORT = { x: 0, y: 0, width: 400, height: 800 };

let deviceSequence = 0;

export function makeIsolatedDevice(): DeviceInfo {
  deviceSequence += 1;
  return { ...ANDROID_EMULATOR, id: `emulator-touch-helper-${deviceSequence}` };
}

export function longPressPlan(durationMs = 120_000): AndroidTouchPlan {
  const point = { x: 20, y: 30 };
  return {
    topology: 'single',
    intent: 'longPress',
    durationMs,
    pointers: [
      {
        pointerId: 0,
        samples: [
          { offsetMs: 0, point },
          { offsetMs: durationMs, point },
        ],
      },
    ],
  };
}

export function flingPlan() {
  return buildGesturePlan(
    { intent: 'fling', from: { x: 300, y: 400 }, to: { x: 100, y: 400 } },
    ANDROID_TOUCH_HELPER_VIEWPORT,
  );
}

// Wraps an executor that answers the shared install-decision probe as "already
// current" (a much newer installed versionCode) so tests can focus on the
// gesture/viewport call that follows without also faking an install flow.
export function currentVersionAdb(handleInstrument: AndroidAdbExecutor): AndroidAdbExecutor {
  return async (args, options) => {
    if (args.includes('--show-versioncode')) {
      return {
        exitCode: 0,
        stdout: `package:${ANDROID_TOUCH_HELPER_MANIFEST.packageName} versionCode:999999`,
        stderr: '',
      };
    }
    return handleInstrument(args, options);
  };
}

// Wraps an executor that answers the install-decision probe as "outdated" (an older installed
// versionCode) and accepts the resulting `adb install`, so ensureAndroidSnapshotHelper actually
// replaces the APK (install.installed === true) before the wrapped call runs.
export function outdatedVersionAdb(handleInstrument: AndroidAdbExecutor): AndroidAdbExecutor {
  return async (args, options) => {
    if (args.includes('--show-versioncode')) {
      return {
        exitCode: 0,
        stdout: `package:${ANDROID_TOUCH_HELPER_MANIFEST.packageName} versionCode:1`,
        stderr: '',
      };
    }
    if (args[0] === 'install') {
      return { exitCode: 0, stdout: 'Success', stderr: '' };
    }
    return handleInstrument(args, options);
  };
}
