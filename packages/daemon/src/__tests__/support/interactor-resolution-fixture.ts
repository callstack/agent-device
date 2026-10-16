import { vi } from 'vitest';
import type {
  Interactor,
  RunnerContext,
  SnapshotOptions,
  SnapshotResult,
} from '@agent-device/contracts/interactor-types';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { installInteractorResolution } from '../../core/interactor-resolution.ts';

type InteractorSnapshotCall = Readonly<{
  device: DeviceInfo;
  runnerContext: RunnerContext;
  options: SnapshotOptions;
}>;

/**
 * The snapshot the resolved interactor answers with. Every capture that falls back to
 * `captureSnapshotWithInteractor` lands here with the `{ device, runnerContext, options }` the
 * production seam hands the interactor, so a suite configures captures and reads their call
 * arguments from one spy.
 */
export const mockInteractorSnapshot = vi.fn<
  (call: InteractorSnapshotCall) => Promise<SnapshotResult>
>(async () => ({
  nodes: [],
  backend: 'xctest',
  producer: 'apple-runner',
}));

/**
 * Installs an interactor resolution whose interactor snapshots through
 * {@link mockInteractorSnapshot}. Call from `beforeEach`; the spy keeps its configuration until the
 * suite resets it.
 */
export function installInteractorSnapshotResolution(): void {
  installInteractorResolution({
    resolve: async (device, runnerContext) =>
      ({
        snapshot: async (options: SnapshotOptions) =>
          await mockInteractorSnapshot({ device, runnerContext, options }),
      }) as unknown as Interactor,
  });
}
