import type { DeviceInfo } from '@agent-device/kernel/device';
import { requireExecSuccess, type ExecOptions } from '@agent-device/host-kit/command';
import { resolveVegaToolProvider } from './tool-provider.ts';

const VEGA_APP_COMMAND_TIMEOUT_MS = 30_000;
const VEGA_APP_COMMAND_OPTIONS = {
  allowFailure: true,
  timeoutMs: VEGA_APP_COMMAND_TIMEOUT_MS,
} satisfies ExecOptions;

export async function openVegaApp(device: Pick<DeviceInfo, 'id'>, appName: string): Promise<void> {
  requireExecSuccess(
    await resolveVegaToolProvider().launchApp(device.id, appName, VEGA_APP_COMMAND_OPTIONS),
    `Failed to launch Vega app ${appName}`,
    { appName, deviceId: device.id },
  );
}

export async function openVegaDevice(device: Pick<DeviceInfo, 'id'>): Promise<void> {
  requireExecSuccess(
    await resolveVegaToolProvider().checkConnected(device.id, VEGA_APP_COMMAND_OPTIONS),
    'Vega device is not connected',
    { deviceId: device.id },
  );
}

export async function closeVegaApp(device: Pick<DeviceInfo, 'id'>, appName: string): Promise<void> {
  requireExecSuccess(
    await resolveVegaToolProvider().terminateApp(device.id, appName, VEGA_APP_COMMAND_OPTIONS),
    `Failed to terminate Vega app ${appName}`,
    { appName, deviceId: device.id },
  );
}
