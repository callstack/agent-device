import type { FoldKeyframe, FoldPose } from '@agent-device/contracts/device';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { execFailureDetails } from '@agent-device/host-kit/command';
import { runSimctlForDevice } from '../core/simctl.ts';
import { ensureFoldHelperBinary } from './fold-helper-cache.ts';

/** Builds (or reuses the cached build of) the fold helper, then dispatches inside the requested simulator. */
export async function sendSimulatorFoldPose(
  device: DeviceInfo,
  pose: FoldPose | readonly FoldKeyframe[],
  signal?: AbortSignal,
  options: Readonly<{ cacheRoot?: string }> = {},
): Promise<void> {
  signal?.throwIfAborted();
  const binary = await ensureFoldHelperBinary({ signal, cacheRoot: options.cacheRoot });
  signal?.throwIfAborted();
  const durationMs = typeof pose === 'string' ? 0 : pose.at(-1)!.atMs;
  const payload = typeof pose === 'string' ? pose : JSON.stringify(pose);
  const sent = await runSimctlForDevice(device, ['spawn', device.id, binary.path, payload], {
    signal,
    timeoutMs: durationMs + 10_000,
    // simctl must forward termination to the guest before the host kills it.
    kill: { signal: 'SIGTERM', graceMs: 1000 },
    allowFailure: true,
  });
  if (sent.exitCode !== 0) {
    throw new AppError(
      'COMMAND_FAILED',
      'Unable to send the simulator hinge pose',
      execFailureDetails(sent, { reason: 'fold-hid-dispatch-failed', deviceId: device.id }),
    );
  }
}
