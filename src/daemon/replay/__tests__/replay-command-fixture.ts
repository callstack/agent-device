import type { ReplayTestAttemptStepSink } from '@agent-device/replay-test';
import type { DaemonInvokeFn, DaemonRequest, DaemonResponse } from '../../types.ts';
import type { SessionStore } from '../../session-store.ts';
import { createReplaySession } from '../../handlers/session-replay-command.ts';
import { runReplayCommand } from '../index.ts';

export type ReplayCommandTestInput = Readonly<{
  req: DaemonRequest;
  sessionName: string;
  logPath: string;
  sessionStore: SessionStore;
  invoke: DaemonInvokeFn;
  tracePath?: string;
  onStep?: ReplayTestAttemptStepSink;
}>;

export function runReplayForTest(params: ReplayCommandTestInput): Promise<DaemonResponse> {
  const { req, sessionName, logPath, sessionStore, invoke, tracePath, onStep } = params;
  return runReplayCommand({
    request: req,
    session: createReplaySession(sessionName, logPath, sessionStore),
    invoke,
    ...(tracePath === undefined ? {} : { tracePath }),
    ...(onStep === undefined ? {} : { onStep }),
  });
}
