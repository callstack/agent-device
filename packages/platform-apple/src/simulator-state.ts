import type { DeviceInfo } from '@agent-device/kernel/device';
import type { AppleToolHost } from '@agent-device/contracts/platform-runtime-host';
import { scopeSimctlArgsForDevice } from './core/simctl.ts';
import { readSimctlDeviceState } from './core/simctl-device-list.ts';

export async function getSimulatorState(
  appleTools: AppleToolHost,
  device: DeviceInfo,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<string | null> {
  const result = await appleTools.run(
    {
      tool: 'simctl',
      args: scopeSimctlArgsForDevice(device, ['list', 'devices', '-j']),
      allowFailure: true,
      timeoutMs,
    },
    signal,
  );
  if (result.exitCode !== 0) return null;
  return readSimctlDeviceState(result.stdout, device.id);
}
