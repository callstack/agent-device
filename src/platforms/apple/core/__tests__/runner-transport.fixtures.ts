import fs from 'node:fs';
import { vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { IOS_DEVICE, IOS_SIMULATOR } from '../../../../__tests__/test-utils/index.ts';

export const iosDevice = IOS_DEVICE;
export const iosSimulator = IOS_SIMULATOR;
export const xctestIosDevice = {
  ...IOS_DEVICE,
  iosPhysicalDeviceBackend: 'xctest' as const,
};

export function usbmuxDeviceUnattachedError(): AppError {
  return new AppError('DEVICE_NOT_FOUND', 'iOS device is not available through usbmux', {
    deviceId: iosDevice.id,
    usbmuxDeviceAttached: false,
    hint: 'Connect the device by cable, trust this Mac, keep it unlocked, and retry.',
  });
}

export function makeTunnelIpLookup(tunnelIp: string) {
  return makeTunnelIpLookupSequence([tunnelIp]);
}

export function makeTunnelIpLookupSequence(tunnelIps: string[]) {
  const remainingTunnelIps = [...tunnelIps];
  return async (_cmd: string, args: string[]) => {
    const jsonPath = args[args.indexOf('--json-output') + 1]!;
    fs.writeFileSync(
      jsonPath,
      JSON.stringify({
        info: { outcome: 'success' },
        result: { connectionProperties: { tunnelIPAddress: remainingTunnelIps.shift() } },
      }),
    );
    return { exitCode: 0, stdout: '', stderr: '' };
  };
}

export function stubSuccessfulFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}')),
  );
}
