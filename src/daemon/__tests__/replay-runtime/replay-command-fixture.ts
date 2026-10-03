import type { ReplayTestAttemptStepSink } from '@agent-device/replay-test';
import type { DaemonInvokeFn, DaemonRequest, DaemonResponse } from '../../daemon-request.ts';
import type { SessionStore } from '../../session-store.ts';
import {
  createReplaySession,
  replayDaemonDependencies,
} from '../../handlers/session-replay-command.ts';
import { runReplayCommand } from '@agent-device/replay-port/native-command';
import {
  replayInvokeOverDispatch,
  splitReplayCommandRequest,
} from '@agent-device/replay-port/replay-dispatch-envelope';
import type { ReplayCommand } from '@agent-device/replay-port/command-types';
import type { ObservationClock } from '@agent-device/capture-kit/observe-until';

export type ReplayCommandTestInput = Readonly<{
  req: DaemonRequest;
  sessionName: string;
  logPath: string;
  sessionStore: SessionStore;
  invoke: DaemonInvokeFn;
  tracePath?: string;
  onStep?: ReplayTestAttemptStepSink;
  /** Paces the target-readiness wait; default: `instantReplayClock`. */
  clock?: ObservationClock;
}>;

/**
 * A replay command bound the way the handler binds it: the wire request and its admission facts,
 * the daemon's session capabilities, and nested dispatch that re-attaches the private half so a
 * test's `invoke` sees the same `DaemonRequest` the daemon would.
 */
export function replayCommandForTest(params: ReplayCommandTestInput): ReplayCommand {
  const { req, sessionName, logPath, sessionStore, invoke, tracePath, onStep, clock } = params;
  return {
    ...splitReplayCommandRequest(req),
    session: createReplaySession(sessionName, logPath, sessionStore),
    invoke: replayInvokeOverDispatch(invoke, req),
    dependencies: { ...replayDaemonDependencies, clock: clock ?? instantReplayClock() },
    ...(tracePath === undefined ? {} : { tracePath }),
    ...(onStep === undefined ? {} : { onStep }),
  };
}

export function runReplayForTest(params: ReplayCommandTestInput): Promise<DaemonResponse> {
  return runReplayCommand(replayCommandForTest(params));
}

/** Target-readiness waits advance this clock instead of sleeping, so a unit replay spends no wall time. */
function instantReplayClock(): ObservationClock {
  let nowMs = Date.now();
  return {
    now: () => nowMs,
    sleep: async (ms) => {
      nowMs += ms;
    },
  };
}
