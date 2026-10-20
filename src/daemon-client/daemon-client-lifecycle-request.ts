import {
  DAEMON_LIFECYCLE_REASONS,
  DAEMON_SHUTTING_DOWN_REASON,
  buildDaemonLifecycleRequest,
  readDaemonLifecycleCensus,
  type DaemonPaths,
} from '@agent-device/daemon-contracts/daemon-resolution';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { createRequestId } from '@agent-device/host-kit/diagnostics';
import { AppError, throwDaemonError } from '@agent-device/kernel/errors';
import type { DaemonInfo } from './daemon-client-metadata.ts';
import { isDaemonTransportUnavailableError, sendRequest } from './daemon-client-transport.ts';
import { daemonBusyError, daemonNotRetirableError } from './daemon-lifecycle-errors.ts';

const LIFECYCLE_REQUEST_TIMEOUT_MS = 10_000;

/** Maximum wait for an idle detached daemon to finish closing during replacement. */
export const DAEMON_LEAVE_WAIT_MS = 60_000;

/** What a lifecycle request needs besides the daemon it addresses: where and how to reach it. */
export type DaemonLifecycleTarget = Readonly<{
  paths: DaemonPaths;
  host: HostEnvironment;
}>;

// A refused or reset connection: the daemon left, is leaving, or was never there. Nothing was
// accepted, so judging again is safe.
function isConnectionFailure(error: unknown): boolean {
  return error instanceof AppError && error.details?.reason === 'daemon_transport_failure';
}

type DaemonLifecycleOutcome = Readonly<{ outcome: 'draining' | 'gone' }>;

/** Asks the fenced detached daemon to leave if idle, without timeout recovery. */
export async function requestDaemonLifecycle(
  info: DaemonInfo,
  target: DaemonLifecycleTarget,
): Promise<DaemonLifecycleOutcome> {
  const requestId = createRequestId();
  const request = buildDaemonLifecycleRequest({
    token: info.token,
    fence: { pid: info.pid, processStartTime: info.processStartTime ?? null },
    requestId,
  });
  let response;
  try {
    response = await sendRequest(
      info,
      request,
      // Whichever transport the daemon serves: a client that cannot reach it on its own preference
      // is exactly the one that has to ask it to leave.
      'auto',
      target.paths,
      LIFECYCLE_REQUEST_TIMEOUT_MS,
      { host: target.host, timeoutRecovery: 'none' },
    );
  } catch (error) {
    if (isDaemonTransportUnavailableError(error) || isConnectionFailure(error))
      return { outcome: 'gone' };
    // HTTP carries the ownership refusal as an error rather than a response.
    const refusal = readOwnerRefusal(error);
    const judged = refusal && judgeRefusedAnswer(refusal, info, target);
    if (judged) return judged;
    throw error;
  }
  if (response.ok) return { outcome: 'draining' };
  const details = response.error.details;
  const judged = judgeRefusedAnswer({ reason: details?.reason, details }, info, target);
  if (judged) return judged;
  throwDaemonError(response.error);
}

/** A daemon's refusal, as read from either transport's shape of it. */
type RefusedDaemonAnswer = Readonly<{ reason: unknown; details: unknown }>;

function readOwnerRefusal(error: unknown): RefusedDaemonAnswer | undefined {
  if (!(error instanceof AppError)) return undefined;
  const reason = error.details?.reason;
  return reason === DAEMON_LIFECYCLE_REASONS.ownerEmbedded
    ? { reason, details: error.details }
    : undefined;
}

function judgeRefusedAnswer(
  refusal: RefusedDaemonAnswer,
  info: DaemonInfo,
  target: DaemonLifecycleTarget,
): DaemonLifecycleOutcome | undefined {
  const stateDir = target.paths.baseDir;
  if (refusal.reason === DAEMON_LIFECYCLE_REASONS.busy) {
    throw daemonBusyError(info, stateDir, readDaemonLifecycleCensus(refusal.details));
  }
  if (refusal.reason === DAEMON_LIFECYCLE_REASONS.ownerEmbedded) {
    throw daemonNotRetirableError({ info, stateDir });
  }
  if (
    refusal.reason === DAEMON_LIFECYCLE_REASONS.instanceMismatch ||
    refusal.reason === DAEMON_SHUTTING_DOWN_REASON
  ) {
    return { outcome: 'gone' };
  }
}
