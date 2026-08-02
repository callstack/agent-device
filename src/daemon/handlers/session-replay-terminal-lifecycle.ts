import type { DaemonResponse, SessionAction, SessionState } from '../types.ts';
import { errorResponse } from './response.ts';

/** A dispatchable step: nested `replay` markers are plan metadata and never dispatch. */
export function isExecutableReplayAction(
  action: SessionAction | undefined,
): action is SessionAction {
  return Boolean(action && action.command !== 'replay');
}

/**
 * Resolves the one native replay lifecycle seam once per plan. Terminal means
 * the last executable action, because nested `replay` markers are plan
 * metadata and never dispatch. The suppressed close is therefore neither
 * divergence-checked nor included in the successful `replayed` count.
 */
export function resolveSuppressedTerminalCloseIndex(params: {
  actions: SessionAction[];
  keepSession: boolean;
  saveScript: boolean | string | undefined;
  repairActive: boolean;
}): number | undefined {
  if (!params.keepSession && !params.saveScript && !params.repairActive) return undefined;
  for (let index = params.actions.length - 1; index >= 0; index -= 1) {
    const action = params.actions[index];
    if (!isExecutableReplayAction(action)) continue;
    return action.command === 'close' ? index : undefined;
  }
  return undefined;
}

export function countExecutedReplayActions(params: {
  actions: SessionAction[];
  entryIndex: number;
  suppressedTerminalCloseIndex: number | undefined;
}): number {
  let count = 0;
  for (let index = params.entryIndex; index < params.actions.length; index += 1) {
    if (index === params.suppressedTerminalCloseIndex) continue;
    if (isExecutableReplayAction(params.actions[index])) count += 1;
  }
  return count;
}

/**
 * `--keep-session`'s postcondition: a suppressed terminal close only ever
 * promises a live session, so a session that is gone by completion anyway
 * (some other action closed or otherwise removed it) must fail loudly rather
 * than silently report `sessionActive: false` as if `--keep-session` had
 * never been requested.
 */
export function requireLiveSessionForKeepSession(params: {
  keepSession: boolean;
  sessionName: string;
  completedSession: SessionState | undefined;
  artifactPaths: Set<string>;
}): DaemonResponse | undefined {
  const { keepSession, sessionName, completedSession, artifactPaths } = params;
  if (!keepSession || completedSession) return undefined;
  return errorResponse(
    'COMMAND_FAILED',
    `Replay completed but --keep-session could not preserve session "${sessionName}". Run the script again after checking which action closed the session.`,
    artifactPaths.size > 0 ? { artifactPaths: [...artifactPaths] } : undefined,
  );
}
