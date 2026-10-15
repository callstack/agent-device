import type { Interactor } from '@agent-device/contracts/interactor-types';
import { installInteractorResolution } from '../../core/interactor-resolution.ts';
import { captureSnapshotThroughLegacyDispatchFixture } from './legacy-snapshot-capture-fixture.ts';

/**
 * Routes the daemon's legacy snapshot capture through the shared capture double
 * (`legacyDispatchCapture`) by installing the interactor resolution the process root would
 * compose. The resolved interactor answers `snapshot` only, so a suite that reaches any other
 * interactor member fails loudly instead of touching a device.
 *
 * Installation is process-global and each vitest file runs in its own module graph, so a suite
 * calls this once at module scope.
 */
export function installLegacyCaptureInteractorResolution(): void {
  installInteractorResolution({
    resolve: async (device, runnerContext) =>
      ({
        snapshot: async (options) =>
          await captureSnapshotThroughLegacyDispatchFixture({
            device,
            runnerContext,
            options: options ?? {},
          }),
      }) as Interactor,
  });
}
