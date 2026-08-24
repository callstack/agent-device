import type { SessionState } from '../types.ts';
import {
  createBoundTouchExecutor,
  resolveBoundTouchRuntime,
  type BoundTouchExecutor,
  type TouchRuntimeCommand,
} from '../touch-runtime.ts';
import type { InteractionHandlerParams } from './interaction-common.ts';
import type { DaemonFailureResponse } from './response.ts';

export type PreparedTouchDispatch =
  | Readonly<{ ok: false; response: DaemonFailureResponse }>
  | Readonly<{ ok: true; touchExecutor: BoundTouchExecutor }>;

/** Exact-owner admission, one bind, and command-context projection shared by every touch route. */
export async function prepareTouchDispatch(
  params: InteractionHandlerParams,
  session: SessionState,
  command: TouchRuntimeCommand,
  requiresCapture: boolean,
): Promise<PreparedTouchDispatch> {
  const bound = await resolveBoundTouchRuntime({
    device: session.device,
    command,
    requiresCapture,
    inspectFacts: params.inspectFacts,
    bindDevice: params.bindDevice,
  });
  if (!bound.ok) return bound;
  return {
    ok: true,
    touchExecutor: createBoundTouchExecutor(
      bound.runtime,
      params.contextFromFlags(params.req.flags, session.appBundleId, session.trace?.outPath),
    ),
  };
}
