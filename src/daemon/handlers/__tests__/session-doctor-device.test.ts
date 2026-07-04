import assert from 'node:assert/strict';
import { test } from 'vitest';
import { withDeviceInventoryProvider } from '../../../core/dispatch-resolve.ts';
import { AppError } from '../../../kernel/errors.ts';
import type { DeviceInfo } from '../../../kernel/device.ts';
import { attachAdbFailureHint } from '../../../platforms/android/adb-executor.ts';
import type { DaemonRequest } from '../../types.ts';
import { appendDeviceInventoryCheck } from '../session-doctor-device.ts';
import type { DoctorCheck } from '../session-doctor-types.ts';

const BOOTED_IOS_SIMULATOR: DeviceInfo = {
  platform: 'apple',
  appleOs: 'ios',
  id: 'SIM-UDID-1',
  name: 'iPhone 16',
  kind: 'simulator',
  booted: true,
};

// Issue #1079 repro: a wedged adb makes `adb devices -l` time out during the
// unscoped doctor inventory sweep. The Android listing routes that failure
// through the adb classifier, and doctor must surface the classified hint on
// the device-android check instead of the generic toolchain fallback.
test('doctor android inventory timeout surfaces the wedged-adb-server hint', async () => {
  const checks: DoctorCheck[] = [];
  const req = { token: 't', session: 'default', command: 'doctor' } as DaemonRequest;

  await withDeviceInventoryProvider(
    async (request) => {
      if (request.platform === 'android') {
        // Same classified error listAndroidDeviceEntries throws when the
        // exec layer times out an adb invocation.
        throw attachAdbFailureHint(
          new AppError('COMMAND_FAILED', 'adb timed out after 10000ms', {
            cmd: 'adb',
            args: ['devices', '-l'],
            stdout: '',
            stderr: '',
            exitCode: -1,
            timeoutMs: 10000,
          }),
        );
      }
      if (request.platform === 'apple') return [BOOTED_IOS_SIMULATOR];
      return [];
    },
    async () => {
      await appendDeviceInventoryCheck(checks, req, undefined);
    },
  );

  const deviceCheck = checks.find((check) => check.id === 'device');
  assert.equal(deviceCheck?.status, 'pass');

  const androidCheck = checks.find((check) => check.id === 'device-android');
  assert.equal(androidCheck?.status, 'warn');
  assert.match(androidCheck?.summary ?? '', /Android device inventory could not be read/);
  assert.match(androidCheck?.summary ?? '', /timed out after 10000ms/);
  assert.match(androidCheck?.hint ?? '', /adb kill-server && adb start-server/);
});
