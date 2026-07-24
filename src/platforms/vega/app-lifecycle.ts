import type { DeviceInfo } from '../../kernel/device.ts';
import { requireExecSuccess, type ExecResult } from '../../utils/exec.ts';
import { resolveVegaToolProvider } from './tool-provider.ts';

const VEGA_APP_COMMAND_TIMEOUT_MS = 30_000;

export async function openVegaApp(device: Pick<DeviceInfo, 'id'>, appName: string): Promise<void> {
  await runVegaDeviceCommand(
    resolveVegaToolProvider().launchApp(device.id, appName, commandOptions()),
    `Failed to launch Vega app ${appName}`,
    { appName, deviceId: device.id },
  );
}

export async function openVegaDevice(device: Pick<DeviceInfo, 'id'>): Promise<void> {
  await runVegaDeviceCommand(
    resolveVegaToolProvider().checkConnected(device.id, commandOptions()),
    'Vega device is not connected',
    { deviceId: device.id },
  );
}

export async function closeVegaApp(device: Pick<DeviceInfo, 'id'>, appName: string): Promise<void> {
  await runVegaDeviceCommand(
    resolveVegaToolProvider().terminateApp(device.id, appName, commandOptions()),
    `Failed to terminate Vega app ${appName}`,
    { appName, deviceId: device.id },
  );
}

async function runVegaDeviceCommand(
  result: Promise<ExecResult>,
  failureMessage: string,
  details: Record<string, unknown>,
): Promise<void> {
  requireExecSuccess(await result, failureMessage, details);
}

function commandOptions() {
  return {
    allowFailure: true,
    timeoutMs: VEGA_APP_COMMAND_TIMEOUT_MS,
  };
}
