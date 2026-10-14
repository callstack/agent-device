import { describe, expect, test } from 'vitest';
import type { TargetShutdownResult } from '@agent-device/contracts/device';
import { ANDROID_EMULATOR, IOS_SIMULATOR } from '@agent-device/test-kit/device-fixtures';
import { deviceStatusReportResponse } from '../session-device-status-response.ts';

const shutdownResult: TargetShutdownResult = {
  success: true,
  exitCode: 0,
  stdout: '',
  stderr: '',
};

describe('deviceStatusReportResponse', () => {
  test('emits the public identity fields with the boot status', () => {
    const response = deviceStatusReportResponse(
      { ...IOS_SIMULATOR, target: 'mobile' },
      { booted: true },
    );
    expect(response).toEqual({
      ok: true,
      data: {
        platform: 'ios',
        target: 'mobile',
        device: 'iPhone 17 Pro',
        id: 'sim-1',
        kind: 'simulator',
        booted: true,
        appleOs: 'ios',
      },
    });
    // The wire order the pre-refactor literals emitted: identity, status, appleOs.
    if (!response.ok || !response.data) return;
    expect(Object.keys(response.data)).toEqual([
      'platform',
      'target',
      'device',
      'id',
      'kind',
      'booted',
      'appleOs',
    ]);
  });

  test('emits the shutdown status and defaults the target to mobile', () => {
    const response = deviceStatusReportResponse(ANDROID_EMULATOR, { shutdown: shutdownResult });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.data).toMatchObject({ target: 'mobile', shutdown: shutdownResult });
    expect(response.data).not.toHaveProperty('booted');
  });

  test('never surfaces a stray appleOs on a non-Apple platform', () => {
    const response = deviceStatusReportResponse(
      { ...ANDROID_EMULATOR, appleOs: 'ios' },
      { booted: true },
    );
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.data).not.toHaveProperty('appleOs');
  });
});
