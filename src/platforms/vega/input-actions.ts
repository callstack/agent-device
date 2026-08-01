import { toVegaTvRemoteKey, type TvRemoteButton } from '@agent-device/contracts/interaction';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { requireExecSuccess } from '../../utils/exec.ts';
import { resolveVegaToolProvider } from './tool-provider.ts';

const VEGA_INPUT_TRANSPORT_OVERHEAD_MS = 10_000;

export async function pressVegaTvRemote(
  device: Pick<DeviceInfo, 'id'>,
  button: TvRemoteButton,
  durationMs?: number,
): Promise<void> {
  const key = toVegaTvRemoteKey(button);
  requireExecSuccess(
    await resolveVegaToolProvider().pressRemote(device.id, key, durationMs, {
      allowFailure: true,
      timeoutMs: VEGA_INPUT_TRANSPORT_OVERHEAD_MS + (durationMs ?? 0),
    }),
    `Failed to press Vega TV remote ${button}`,
    {
      button,
      deviceId: device.id,
    },
  );
}
