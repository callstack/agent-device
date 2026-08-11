import type { DaemonResponse } from '../types.ts';
import type { InteractionHandlerParams } from './interaction-common.ts';
import type { RefSnapshotFlagGuardResponse } from './interaction-flags.ts';
import type { CaptureSnapshotForSession } from './interaction-snapshot.ts';
import { dispatchFillViaRuntime } from './interaction-touch-fill.ts';
import { dispatchTargetedTouchViaRuntime } from './interaction-touch-press.ts';

/** Which touch command handler owns this request; every policy lives below. */
export async function handleTouchInteractionCommands(
  params: InteractionHandlerParams & {
    captureSnapshotForSession: CaptureSnapshotForSession;
    refSnapshotFlagGuardResponse: RefSnapshotFlagGuardResponse;
  },
): Promise<DaemonResponse | null> {
  switch (params.req.command) {
    case 'press':
      return await dispatchTargetedTouchViaRuntime(params, 'press');
    case 'click':
      return await dispatchTargetedTouchViaRuntime(params, 'click');
    case 'longpress':
      return await dispatchTargetedTouchViaRuntime(params, 'longpress');
    case 'fill':
      return await dispatchFillViaRuntime(params);
    default:
      return null;
  }
}
