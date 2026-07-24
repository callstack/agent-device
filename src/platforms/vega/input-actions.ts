import { AppError } from '../../kernel/errors.ts';
import { toVegaTvRemoteKey, type TvRemoteButton } from '../../contracts/tv-remote.ts';
import { requireExecSuccess } from '../../utils/exec.ts';
import type { VegaDeviceInfo } from './devices.ts';
import { resolveVegaToolProvider } from './tool-provider.ts';

const VEGA_INPUT_TRANSPORT_OVERHEAD_MS = 10_000;

export async function pressVegaTvRemote(
  device: Pick<VegaDeviceInfo, 'id'>,
  button: TvRemoteButton,
  durationMs?: number,
): Promise<void> {
  if (
    durationMs !== undefined &&
    (!Number.isInteger(durationMs) || durationMs < 0 || durationMs > 10_000)
  ) {
    throw new AppError(
      'INVALID_ARGS',
      'Vega TV remote durationMs must be an integer between 0 and 10000.',
      { durationMs },
    );
  }

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
