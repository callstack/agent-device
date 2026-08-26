import { vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { SnapshotResult } from '@agent-device/contracts/interactor-types';
import type { captureSnapshotWithInteractor } from '../handlers/snapshot-interactor-capture.ts';

type CaptureParams = Parameters<typeof captureSnapshotWithInteractor>[0];

/**
 * The capture double these suites drive their snapshots through. It kept the retired
 * `dispatchCommand` signature when R58 deleted that dispatcher, so every suite that configured
 * captures through it — and every assertion about which commands reached a device — reads
 * unchanged; what moved is ownership. This is a test seam now, not an adapter over production
 * dispatch.
 */
export const legacyDispatchCapture = vi.fn<
  (
    device: DeviceInfo,
    command: string,
    positionals?: string[],
    outPath?: string,
    context?: Record<string, unknown>,
  ) => Promise<Record<string, unknown> | void>
>(async () => ({}));

/**
 * One reset for the whole seam: clears the double, restores its empty-payload default, and
 * re-points the suite's mocked `captureSnapshotWithInteractor` at the adapter below. Every suite
 * that drives captures this way wired the same four statements by hand; they are the seam's own
 * mechanics, not per-suite policy, so they live with the seam.
 */
export function resetLegacySnapshotCapture(
  mockedInteractorCapture: Readonly<{
    mockReset: () => void;
    mockImplementation: (fn: typeof captureSnapshotThroughLegacyDispatchFixture) => void;
  }>,
): void {
  legacyDispatchCapture.mockReset();
  legacyDispatchCapture.mockResolvedValue({});
  mockedInteractorCapture.mockReset();
  mockedInteractorCapture.mockImplementation(captureSnapshotThroughLegacyDispatchFixture);
}

/** Adapts the capture double into the snapshot-specific interactor seam production uses. */
export async function captureSnapshotThroughLegacyDispatchFixture({
  device,
  runnerContext,
  options,
}: CaptureParams): Promise<SnapshotResult> {
  return (await legacyDispatchCapture(device, 'snapshot', [], undefined, {
    ...runnerContext,
    ...options,
    snapshotInteractiveOnly: options.interactiveOnly,
    snapshotPreferredBackend: options.preferredBackend,
    snapshotDepth: options.depth,
    snapshotScope: options.scope,
    snapshotRaw: options.raw,
    snapshotCustomActions: options.customActions,
    snapshotIncludeRects: options.includeRects,
    snapshotIncludeHiddenContentHints: options.includeHiddenContentHints,
  })) as SnapshotResult;
}
