import type {
  RunnerContext,
  SnapshotOptions,
  SnapshotResult,
} from '@agent-device/contracts/interactor-types';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { interactorResolution } from './interactor-resolution.ts';

/**
 * Legacy snapshot consumers that have not moved to a device-runtime operation
 * still capture through the selected interactor. Keeping this seam snapshot-
 * specific avoids restoring the retired generic command dispatcher route.
 *
 * The interactor arrives through the resolution capability root composition
 * installs; this module never looks one up itself.
 */
export async function captureSnapshotWithInteractor(params: {
  device: DeviceInfo;
  runnerContext: RunnerContext;
  options: SnapshotOptions;
}): Promise<SnapshotResult> {
  const interactor = await interactorResolution().resolve(params.device, params.runnerContext);
  const result = await interactor.snapshot(params.options);
  if (!('stage' in result)) return result;
  const { presentIosSnapshotAcquisition } =
    await import('@agent-device/capture-kit/ios-snapshot-runtime');
  return await presentIosSnapshotAcquisition(result, params.options);
}
