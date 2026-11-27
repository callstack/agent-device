import type { ReasonTable } from '@agent-device/kernel/errors';

// Why a daemon call stopped at the transport boundary, so no command ran and no result is implied.
// A daemon that answers names its own refusal in the reply instead. Only the client writes these.
export const DAEMON_TRANSPORT_REASONS = {
  // The daemon's socket or HTTP endpoint is unreachable; `details.transport` names the one tried.
  endpointUnavailable: { reason: 'daemon_endpoint_unavailable' },
  // The connection to the daemon broke; `details.daemonRequestSent` says whether the request was written.
  failure: { reason: 'daemon_transport_failure' },
  // The daemon did not answer within the request's budget; `details.timeoutMs` is that budget.
  // For a sent remote request, `details.remoteResponseStarted` says whether a progress stream had
  // already begun, and `details.remoteHealthAnswered` says whether `/health` answered when it had not.
  timeout: { reason: 'daemon_transport_timeout' },
  // A message the daemon sent is not a daemon response envelope; `details.line`, when present,
  // carries what arrived.
  replyInvalid: { reason: 'daemon_response_invalid' },
  // The response body could not be read before the connection ended.
  replyUnreadable: { reason: 'daemon_response_read_failure' },
  // The serialized request passes `DAEMON_REQUEST_MAX_BYTES`, so it was refused before being sent.
  requestTooLarge: { reason: 'daemon_request_too_large' },
} as const satisfies ReasonTable<'daemon transport'>;
