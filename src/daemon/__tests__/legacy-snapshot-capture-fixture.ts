import type { SnapshotResult } from '@agent-device/contracts/interaction';
import { dispatchCommand } from '../../core/dispatch.ts';
import type { captureSnapshotWithInteractor } from '../handlers/snapshot-interactor-capture.ts';

type CaptureParams = Parameters<typeof captureSnapshotWithInteractor>[0];

/** Adapts legacy dispatch mocks while production uses the snapshot-specific interactor seam. */
export async function captureSnapshotThroughLegacyDispatchFixture({
  device,
  runnerContext,
  options,
}: CaptureParams): Promise<SnapshotResult> {
  return (await dispatchCommand(device, 'snapshot', [], undefined, {
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
