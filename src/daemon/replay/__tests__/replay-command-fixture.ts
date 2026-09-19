import type { ReplayTestAttemptStepSink } from '@agent-device/replay-test';
import type { DaemonInvokeFn, DaemonRequest, DaemonResponse } from '../../daemon-request.ts';
import type { SessionStore } from '../../session-store.ts';
import {
  createReplaySession,
  replayDaemonDependencies,
} from '../../handlers/session-replay-command.ts';
import { replayInvokeOverDispatch, runReplayCommand, splitReplayCommandRequest } from '../index.ts';
import type { ReplayCommand } from '../internal/command-types.ts';

export type ReplayCommandTestInput = Readonly<{
  req: DaemonRequest;
  sessionName: string;
  logPath: string;
  sessionStore: SessionStore;
  invoke: DaemonInvokeFn;
  tracePath?: string;
  onStep?: ReplayTestAttemptStepSink;
}>;

/**
 * A replay command bound the way the handler binds it: the wire request and its admission facts,
 * the daemon's session capabilities, and nested dispatch that re-attaches the private half so a
 * test's `invoke` sees the same `DaemonRequest` the daemon would.
 */
export function replayCommandForTest(params: ReplayCommandTestInput): ReplayCommand {
  const { req, sessionName, logPath, sessionStore, invoke, tracePath, onStep } = params;
  return {
    ...splitReplayCommandRequest(req),
    session: createReplaySession(sessionName, logPath, sessionStore),
    invoke: replayInvokeOverDispatch(invoke, req),
    dependencies: replayDaemonDependencies,
    ...(tracePath === undefined ? {} : { tracePath }),
    ...(onStep === undefined ? {} : { onStep }),
  };
}

export function runReplayForTest(params: ReplayCommandTestInput): Promise<DaemonResponse> {
  return runReplayCommand(replayCommandForTest(params));
}
