import {
  DAEMON_QUIESCE_REASONS,
  DAEMON_SHUTTING_DOWN_REASON,
  buildDaemonQuiesceRequest,
  readDaemonQuiesceCensus,
} from '@agent-device/daemon-contracts/daemon-resolution';
import { createRequestId } from '@agent-device/host-kit/diagnostics';
import { AppError, throwDaemonError } from '@agent-device/kernel/errors';
import type { DaemonInfo } from './daemon-client-metadata.ts';
import type { DaemonClientSettings } from './daemon-client-lifecycle.ts';
import { isDaemonTransportUnavailableError, sendRequest } from './daemon-client-transport.ts';
import { daemonBusyError } from './daemon-lifecycle-errors.ts';

const QUIESCE_TIMEOUT_MS = 10_000;

// A refused or reset connection: the daemon left, is leaving, or was never there. Nothing was
// accepted, so judging again is safe.
function isConnectionFailure(error: unknown): boolean {
  return error instanceof AppError && error.details?.reason === 'daemon_transport_failure';
}

/**
 * `draining`: the daemon accepted and is leaving. `gone`: the daemon the request was addressed to
 * is no longer there to answer, because it left, is leaving already, or was replaced.
 */
export type QuiesceOutcome = 'draining' | 'gone';

/**
 * Asks the daemon to leave, fenced to the instance `info` names. A daemon that holds work refuses
 * with `daemon-busy`, and that refusal is the answer: nothing here signals it. A timeout is not
 * recovered here either; the caller decides what an unresponsive daemon deserves.
 */
export async function requestDaemonQuiesce(
  info: DaemonInfo,
  settings: DaemonClientSettings,
): Promise<QuiesceOutcome> {
  const request = buildDaemonQuiesceRequest({
    token: info.token,
    fence: { pid: info.pid, processStartTime: info.processStartTime ?? null },
    requestId: createRequestId(),
  });
  let response;
  try {
    response = await sendRequest(
      info,
      request,
      // Whichever transport the daemon serves: a client that cannot reach it on its own preference
      // is exactly the one that has to ask it to leave.
      'auto',
      settings.paths,
      QUIESCE_TIMEOUT_MS,
      { timeoutRecovery: 'none' },
    );
  } catch (error) {
    if (isDaemonTransportUnavailableError(error) || isConnectionFailure(error)) return 'gone';
    throw error;
  }
  if (response.ok) return 'draining';
  const reason = response.error.details?.reason;
  if (reason === DAEMON_QUIESCE_REASONS.busy) {
    throw daemonBusyError(
      info,
      settings.paths.baseDir,
      readDaemonQuiesceCensus(response.error.details),
    );
  }
  if (
    reason === DAEMON_QUIESCE_REASONS.instanceMismatch ||
    reason === DAEMON_SHUTTING_DOWN_REASON
  ) {
    return 'gone';
  }
  return throwDaemonError(response.error);
}
