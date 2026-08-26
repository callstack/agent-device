import type { DeviceInfo } from '@agent-device/kernel/device';
import type { AppleToolHost } from '@agent-device/contracts/platform-runtime-host';

export async function getSimulatorState(
  appleTools: AppleToolHost,
  device: DeviceInfo,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<string | null> {
  const result = await appleTools.run(
    {
      tool: 'simctl',
      args: simctlArgs(device, ['list', 'devices', '-j']),
      allowFailure: true,
      timeoutMs,
    },
    signal,
  );
  if (result.exitCode !== 0) return null;
  try {
    const payload = JSON.parse(result.stdout) as {
      devices?: Record<string, Array<{ udid: string; state: string }>>;
    };
    return (
      Object.values(payload.devices ?? {})
        .flat()
        .find(({ udid }) => udid === device.id)?.state ?? null
    );
  } catch {
    return null;
  }
}

export function simctlArgs(device: DeviceInfo, args: readonly string[]): string[] {
  return device.simulatorSetPath ? ['--set', device.simulatorSetPath, ...args] : [...args];
}
