// Shared by the generic dispatcher and its leaves; leaves must not import the dispatcher.

import type { DaemonCommandContext } from './context.ts';
import type { DaemonRequest, DaemonResponse } from './daemon-request.ts';
import type { SessionState } from './session-state.ts';

export type GenericPlatformExecutionParams = {
  session: SessionState;
  sessionName: string;
  logPath: string;
  command: string;
  request: DaemonRequest;
  positionals: string[];
  out: string | undefined;
  dispatchContext: DaemonCommandContext;
};

/**
 * What actually performs a generic leaf's platform work: the already-admitted, already-bound
 * closure the leaf's own runtime resolution supplied (ADR 0019). R58 retired the legacy
 * alternative, so this is the only shape.
 */
export type GenericPlatformExecution = (
  params: GenericPlatformExecutionParams,
) => Promise<Record<string, unknown> | void>;

/**
 * What the session action records for this request. A runtime-owned leaf may normalize its
 * arguments (a screenshot destination is a user-typed path) and records the normalized form.
 */
export type RecordedGenericRequest = Readonly<{
  positionals: string[];
  flags: Record<string, unknown>;
}>;

/** What a runtime-owned generic leaf resolves to before the dispatcher runs: a refusal, or the
 * bound execution plus whatever the session action should record for it. */
export type ResolvedGenericExecution =
  | Readonly<{ ok: false; response: DaemonResponse }>
  | Readonly<{ ok: true; execute: GenericPlatformExecution; recorded?: RecordedGenericRequest }>;
