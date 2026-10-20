import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { AppleToolHost } from '@agent-device/contracts/platform-runtime-host';
import { readSimctlDeviceState, scopeSimctlArgsForDevice } from './core/simctl.ts';

export async function getSimulatorState(
  appleTools: AppleToolHost,
  device: DeviceInfo,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<string | null> {
  const started = performance.now();
  emitDiagnostic({ phase: 'simulator_state', data: { event: 'start', timeoutMs } });
  try {
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
  } finally {
    emitDiagnostic({
      phase: 'simulator_state',
      durationMs: performance.now() - started,
      data: { event: 'settled', timeoutMs },
    });
  }
}
