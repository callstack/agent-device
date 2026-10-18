import {
  DAEMON_LIFECYCLE_REASONS,
  DAEMON_SHUTTING_DOWN_REASON,
  buildDaemonLifecycleRequest,
  readDaemonLifecycleCensus,
  type DaemonLifecycleMode,
  type DaemonPaths,
} from '@agent-device/daemon-contracts/daemon-resolution';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { createRequestId } from '@agent-device/host-kit/diagnostics';
import { AppError, throwDaemonError } from '@agent-device/kernel/errors';
import type { DaemonInfo } from './daemon-client-metadata.ts';
import { isDaemonTransportUnavailableError, sendRequest } from './daemon-client-transport.ts';
import { daemonBusyError, daemonNotRetirableError } from './daemon-lifecycle-errors.ts';

const LIFECYCLE_REQUEST_TIMEOUT_MS = 10_000;

/**
 * How long a daemon or runtime that agreed to leave gets to finish leaving. Its own shutdown is bounded
 * in phases (server close, session and lease teardown, plugin disposal, provider release), so this is
 * the longest a healthy close can take with margin, not a polling interval. Both waits a client keeps
 * after that agreement — `ensureDaemon` replacing a detached daemon, and a stop of an embedder-owned
 * runtime — use it, because the same close runs either way: a shorter one would report an unconfirmed
 * failure for a close that was still succeeding.
 */
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

/**
 * `draining`: the daemon accepted and is leaving, which is all its own close needs to know — what a
 * stop waits for afterwards is the completion record, and that answers by instance, not by request.
 * `gone`: the daemon the request was addressed to is no longer there to answer, because it left, is
 * leaving already, or was replaced.
 */
export type DaemonLifecycleOutcome = Readonly<{ outcome: 'draining' | 'gone' }>;

/**
 * Asks the daemon `info` names to leave, by the rule `mode` states, and reports its answer.
 *
 * The request is fenced to that instance, so a replacement refuses it. A quiesce a daemon that holds
 * work refuses with `daemon-busy`, and that refusal is the answer: nothing here signals it. A
 * shutdown a detached daemon refuses names its owner instead, because a detached daemon is stopped by
 * signalling its process. A timeout is not recovered here either; the caller decides what an
 * unresponsive daemon deserves.
 */
export async function requestDaemonLifecycle(
  info: DaemonInfo,
  target: DaemonLifecycleTarget,
  mode: DaemonLifecycleMode,
): Promise<DaemonLifecycleOutcome> {
  const requestId = createRequestId();
  const request = buildDaemonLifecycleRequest({
    mode,
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
    // Over HTTP a daemon's refusal arrives as an error carrying its reason, not as the response that
    // carries it. The three ownership refusals are judged here so an embedded runtime says the same
    // thing whichever transport it serves; every other reason keeps the path it shipped with.
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

/**
 * The refusals that name who owns the process. Quiesce never answers with one, so judging them on the
 * error path cannot change a shipped refusal; it only gives the shutdown request the same answer a
 * socket client already got.
 */
const OWNER_REFUSALS: readonly string[] = [
  DAEMON_LIFECYCLE_REASONS.ownerEmbedded,
  DAEMON_LIFECYCLE_REASONS.notEmbedded,
];

function readOwnerRefusal(error: unknown): RefusedDaemonAnswer | undefined {
  if (!(error instanceof AppError)) return undefined;
  const reason = error.details?.reason;
  return typeof reason === 'string' && OWNER_REFUSALS.includes(reason)
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
  // A detached daemon has an owner that can signal it, and a host owns an embedded runtime: either
  // way, this client is not the one that ends it. The daemon's own answer says which owner is on the
  // other side of that line, so it is trusted over this process's possibly-stale read of the record.
  if (refusal.reason === DAEMON_LIFECYCLE_REASONS.notEmbedded) {
    throw daemonNotRetirableError({ info, stateDir, owner: 'detached' });
  }
  if (refusal.reason === DAEMON_LIFECYCLE_REASONS.ownerEmbedded) {
    throw daemonNotRetirableError({ info, stateDir, owner: 'embedded' });
  }
  if (
    refusal.reason === DAEMON_LIFECYCLE_REASONS.instanceMismatch ||
    refusal.reason === DAEMON_SHUTTING_DOWN_REASON
  ) {
    return { outcome: 'gone' };
  }
}
