import type { SessionState } from '../../../core/session-state.ts';
import {
  createBoundTouchExecutor,
  resolveBoundTouchRuntime,
  type BoundTouchExecutor,
  type TouchRuntimeCommand,
} from '../../../core/touch-runtime.ts';
import { readSettleRequest } from './interaction-flags.ts';
import type { BoundSnapshotCapture } from '../../../core/snapshot-runtime-binding.ts';
import { resolveSettleObservationCapture } from '../../../core/settle-observation-capture.ts';
import type { InteractionRouteInput } from '../../../core/interaction/internal/types.ts';
import type { DaemonFailureResponse } from '@agent-device/kernel/contracts';
import { refusedBeforeDispatch } from '../../request-dispatch-disclosure.ts';

export type PreparedTouchDispatch =
  | Readonly<{ ok: false; response: DaemonFailureResponse }>
  | Readonly<{
      ok: true;
      touchExecutor: BoundTouchExecutor;
      /**
       * The observation capture this request still owes: only a route whose action runtime use
       * carries no capture and owes a settle observation can produce one, so every other touch
       * dispatch pays no admission and no bind.
       */
      settleObservationCapture: BoundSnapshotCapture | undefined;
    }>;

/**
 * Exact-owner admission, the command-context projection, and — for a coordinate route that owes a
 * settle observation — the request's own capture-only bind, shared by every touch route.
 */
export async function prepareTouchDispatch(
  params: InteractionRouteInput,
  session: SessionState,
  command: TouchRuntimeCommand,
  requiresCapture: boolean,
): Promise<PreparedTouchDispatch> {
  const bound = await resolveBoundTouchRuntime({
    device: session.device,
    command,
    requiresCapture,
    inspectFacts: params.inspectFacts,
    platformServices: params.platformServices,
    bindDevice: params.bindDevice,
  });
  if (!bound.ok) return { ok: false, response: refusedBeforeDispatch(bound.response) };
  const touchExecutor = createBoundTouchExecutor(
    bound.runtime,
    params.contextFromFlags(params.req.flags, session.appBundleId, session.trace?.outPath),
  );
  const owesObservationCapture =
    touchExecutor.captureSnapshot === undefined &&
    readSettleRequest(params.req.flags) !== undefined;
  const settleObservationCapture = owesObservationCapture
    ? await resolveSettleObservationCapture({
        command: params.req.command,
        session,
        inspectFacts: params.inspectFacts,
        platformServices: params.platformServices,
        bindDevice: params.bindDevice,
      })
    : undefined;
  return {
    ok: true,
    touchExecutor,
    settleObservationCapture,
  };
}
