import type { DeviceInfo } from '@agent-device/kernel/device';
import { requireCommandSuccess } from '@agent-device/kernel/errors';
import { resolveVegaToolProvider } from './tool-provider.ts';
import type { VegaCommandOptions } from '@agent-device/contracts/vega-tool-provider';

const VEGA_APP_COMMAND_TIMEOUT_MS = 30_000;
const VEGA_APP_COMMAND_OPTIONS = {
  allowFailure: true,
  timeoutMs: VEGA_APP_COMMAND_TIMEOUT_MS,
} satisfies VegaCommandOptions;

export async function openVegaApp(device: Pick<DeviceInfo, 'id'>, appName: string): Promise<void> {
  requireCommandSuccess(
    await resolveVegaToolProvider().launchApp(device.id, appName, VEGA_APP_COMMAND_OPTIONS),
    `Failed to launch Vega app ${appName}`,
    { appName, deviceId: device.id },
  );
}

export async function openVegaDevice(device: Pick<DeviceInfo, 'id'>): Promise<void> {
  requireCommandSuccess(
    await resolveVegaToolProvider().checkConnected(device.id, VEGA_APP_COMMAND_OPTIONS),
    'Vega device is not connected',
    { deviceId: device.id },
  );
}

export async function closeVegaApp(device: Pick<DeviceInfo, 'id'>, appName: string): Promise<void> {
  requireCommandSuccess(
    await resolveVegaToolProvider().terminateApp(device.id, appName, VEGA_APP_COMMAND_OPTIONS),
    `Failed to terminate Vega app ${appName}`,
    { appName, deviceId: device.id },
  );
}
