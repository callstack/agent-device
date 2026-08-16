import type {
  CaptureSnapshotInput,
  PlatformRuntimeHost,
  PlatformRuntimeOperations,
} from '@agent-device/contracts/platform';
import { bindLocalSnapshotInteractor } from '@agent-device/contracts/platform';
import { isMacOs, type DeviceInfo } from '@agent-device/kernel/device';

/** Apple-owned selection between app snapshots and explicit macOS surface snapshots. */
export function bindAppleSnapshotRuntime(
  host: PlatformRuntimeHost,
  request: Readonly<{ device: DeviceInfo; signal: AbortSignal }>,
): SnapshotRuntimeOperation {
  const appSnapshot = bindLocalSnapshotInteractor({
    device: request.device,
    signal: request.signal,
    resolveInteractor: host.localInteractors.resolve,
  });
  return Object.freeze({
    captureSnapshot: async (input: CaptureSnapshotInput) => {
      if (
        isMacOs(request.device) &&
        input.options?.surface !== undefined &&
        input.options.surface !== 'app'
      ) {
        return await host.snapshot.apple.captureSurface(
          request.device,
          input.options,
          request.signal,
        );
      }
      return await appSnapshot.captureSnapshot(input);
    },
  });
}

type SnapshotRuntimeOperation = Pick<PlatformRuntimeOperations, 'captureSnapshot'>;
