// The client half of the checked RPC route (ADR 0006): what a refusal or an unknown-route answer
// means for the caller, and the `connect` check that the remote serves the route at all. Loaded only
// on those paths, so a command that gets its answer never pays for it.
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { AppError, discloseUnclassifiedDispatch } from '@agent-device/kernel/errors';
import { isRecord } from '@agent-device/kernel/record';
import {
  DAEMON_CHECKED_RPC_REASONS,
  DAEMON_HTTP_CHECKED_RPC_CAPABILITY,
  DAEMON_HTTP_REFUSAL_HEADER,
  DAEMON_HTTP_REFUSALS,
} from '@agent-device/contracts/daemon-http';
import { DAEMON_TRANSPORT_REASONS } from './daemon-client-transport-reasons.ts';
import { incompatibleRemoteProtocolError } from './daemon-client-rpc.ts';
import type { RemoteDaemonHealth } from './daemon-client-transport.ts';
import { remoteDaemonUnavailableError } from './daemon-lifecycle-errors.ts';

/** The most of a refusal body the client reads: its metadata is a few short fields. */
const REFUSAL_BODY_MAX_BYTES = 64 * 1024;
/** The most of a 404 body the client reads to tell a daemon's JSON-RPC answer from a route miss. */
const NOT_FOUND_BODY_MAX_BYTES = 1024 * 1024;

const UNSUPPORTED_HINT =
  'The remote daemon or proxy does not serve checked RPC. Update it, or remove daemonRpc from the remote-config profile and run agent-device connect --force.';

/** The transport's validated `/health` link reader, which refusal metadata goes through too. */
type ReadHealthLink = (
  parsed: Record<string, unknown>,
) => Pick<RemoteDaemonHealth, 'service' | 'version' | 'rpcProtocolVersion'>;

/**
 * A checked call's connection never opened: refused, or not open within the `/health` probe's time.
 * Only this client can know it, so it is the one evidence that nothing was sent. Client-internal:
 * the resend module turns it into the outcome the caller sees.
 */
export class CheckedRpcConnectFailure extends Error {
  readonly timedOut: boolean;
  constructor(timedOut: boolean) {
    super(timedOut ? 'Checked RPC connect timed out' : 'Checked RPC connect failed');
    this.timedOut = timedOut;
  }
}

/**
 * Watches whether a checked call's connection opens (TLS included) within `timeoutMs`, and calls
 * `onTimeout` when it does not. Before it opens, nothing can have been sent.
 */
export function watchCheckedRpcConnect(
  request: { on(event: 'socket', listener: (socket: Socket) => void): unknown },
  timeoutMs: number,
  onTimeout: () => void,
): {
  unconnected(): boolean;
  failure(timedOut: boolean): CheckedRpcConnectFailure;
  stop(): void;
} {
  let connected = false;
  const timer = setTimeout(() => {
    if (!connected) onTimeout();
  }, timeoutMs);
  const onConnected = (): void => {
    connected = true;
    clearTimeout(timer);
  };
  request.on('socket', (socket) => {
    if (!socket.connecting) onConnected();
    else socket.once('encrypted' in socket ? 'secureConnect' : 'connect', onConnected);
  });
  return {
    unconnected: () => !connected,
    failure: (timedOut) => new CheckedRpcConnectFailure(timedOut),
    stop: () => clearTimeout(timer),
  };
}

/** A checked call's 404, or its 409 that names the refusing precondition. */
export function isCheckedRpcOutcomeResponse(
  statusCode: number | undefined,
  headers: Record<string, string | string[] | undefined>,
): boolean {
  return (
    statusCode === 404 ||
    (statusCode === 409 && typeof headers[DAEMON_HTTP_REFUSAL_HEADER] === 'string')
  );
}

/**
 * What a checked call's 404 or refusal 409 means. `answer` is a JSON-RPC body the daemon wrote, which the
 * caller reads like any other answer. `refused` is final: nothing is resent.
 */
type CheckedRpcOutcome = { kind: 'answer'; body: string } | { kind: 'refused'; error: AppError };

/**
 * Reads a checked call's 404, or its 409 that carries a refusal header. That 409 is a refusal made
 * before dispatch. A 404 whose body is not a JSON-RPC answer is a route this remote does not serve; an
 * ingress may still have answered for a command that ran, so the request is never resent.
 */
export async function readCheckedRpcOutcome(
  res: IncomingMessage,
  readLink: ReadHealthLink,
): Promise<CheckedRpcOutcome> {
  const notFound = res.statusCode === 404;
  const body = await readBoundedBody(
    res,
    notFound ? NOT_FOUND_BODY_MAX_BYTES : REFUSAL_BODY_MAX_BYTES,
  );
  if (notFound) {
    return body !== undefined && isJsonRpcAnswer(body)
      ? { kind: 'answer', body }
      : { kind: 'refused', error: checkedRpcUnsupportedError('unknown') };
  }
  return {
    kind: 'refused',
    error: checkedRpcRefusalError(String(res.headers[DAEMON_HTTP_REFUSAL_HEADER]), body, readLink),
  };
}

function checkedRpcRefusalError(
  refusal: string,
  body: string | undefined,
  readLink: ReadHealthLink,
): AppError {
  switch (refusal) {
    case DAEMON_HTTP_REFUSALS.protocolMismatch:
    case DAEMON_HTTP_REFUSALS.upstreamProtocolMismatch:
      return protocolMismatchError(refusal, body, readLink);
    case DAEMON_HTTP_REFUSALS.protocolMissing:
      return new AppError(
        'COMMAND_FAILED',
        'The remote refused the checked RPC call because it named no RPC protocol',
        {
          reason: DAEMON_CHECKED_RPC_REASONS.protocolMissing.reason,
          dispatched: 'no',
          hint: 'An ingress between this client and the remote removes the x-agent-device-rpc-protocol header. Fix that ingress, or remove daemonRpc from the connection profile.',
        },
      );
    default:
      // A refusal this build does not know proves nothing about dispatch: the reply is unreadable,
      // and the transport discloses it like any reply it cannot read. It is never resent, and its
      // value, which any intermediary can set, never reaches the error.
      return new AppError('COMMAND_FAILED', 'Invalid daemon RPC response', {
        reason: DAEMON_TRANSPORT_REASONS.replyInvalid.reason,
        refusal: 'unknown',
      });
  }
}

/**
 * Today's upgrade message, with the typed reason and the refusing side's bounded, validated
 * `service`, `version` and `rpcProtocolVersion`. A refusal without them, which a daemon sends a call
 * it could not authenticate, keeps the reason alone.
 */
function protocolMismatchError(
  refusal: string,
  body: string | undefined,
  readLink: ReadHealthLink,
): AppError {
  const link = readLink(readRefusalDetails(body));
  const typed = {
    reason: DAEMON_CHECKED_RPC_REASONS.protocolMismatch.reason,
    dispatched: 'no' as const,
  };
  if (typeof link.rpcProtocolVersion !== 'number' || !Number.isInteger(link.rpcProtocolVersion)) {
    return new AppError('COMMAND_FAILED', 'Remote daemon RPC protocol is incompatible', {
      ...typed,
      hint: 'Upgrade agent-device so this client and the remote speak the same RPC protocol.',
    });
  }
  const upgrade = incompatibleRemoteProtocolError(
    '',
    { ...link, rpcProtocolVersion: link.rpcProtocolVersion },
    refusal === DAEMON_HTTP_REFUSALS.upstreamProtocolMismatch
      ? { service: 'agent-device-proxy' }
      : undefined,
  );
  const { daemonBaseUrl: _endpoint, ...upgradeDetails } = upgrade.details ?? {};
  return new AppError(upgrade.code, upgrade.message, {
    ...upgradeDetails,
    ...typed,
    service: link.service,
    version: link.version,
    rpcProtocolVersion: link.rpcProtocolVersion,
  });
}

/** The typed failure when the remote does not serve checked RPC. A command is never resent. */
function checkedRpcUnsupportedError(
  dispatched: 'no' | 'unknown',
  hint = UNSUPPORTED_HINT,
): AppError {
  return new AppError('COMMAND_FAILED', 'The remote does not serve checked RPC', {
    reason: DAEMON_CHECKED_RPC_REASONS.routeUnsupported.reason,
    dispatched,
    hint,
  });
}

/**
 * The same failure without the endpoint: no error raised at the checked connect or send boundary
 * names the daemon URL, which can carry a credential. The code, message, typed reason, dispatch and
 * validated upgrade details stay; the cause, which may quote the URL, does not.
 */
export function withoutEndpoint(error: unknown): unknown {
  if (!(error instanceof AppError)) return error;
  const { daemonBaseUrl: _endpoint, ...details } = error.details ?? {};
  return new AppError(error.code, error.message, details);
}

/** A failure that proves nothing left, without the endpoint. */
export function undispatchedWithoutEndpoint(error: unknown): unknown {
  const scrubbed = withoutEndpoint(error);
  return scrubbed instanceof AppError ? discloseUnclassifiedDispatch(scrubbed, 'no') : scrubbed;
}

/**
 * Refuses `daemonRpc: checked` at `connect` unless every link the command RPC crosses advertises the
 * `checked-rpc` capability in `health`. A proxy proves its daemon only through `upstream`, which must
 * identify as a daemon: no upstream, or another proxy behind it, is refused rather than guessed at.
 */
export function assertHealthServesCheckedRpc(health: RemoteDaemonHealth): void {
  if (!health.reachable)
    throw remoteDaemonUnavailableError({ daemonBaseUrl: undefined, attempts: 1 });
  const proxied = health.service === 'agent-device-proxy';
  if (proxied && health.upstream?.service !== 'agent-device-daemon') {
    throw checkedRpcUnsupportedError('no');
  }
  const links = proxied ? [health, health.upstream] : [health];
  if (links.every((link) => link?.capabilities?.includes(DAEMON_HTTP_CHECKED_RPC_CAPABILITY)))
    return;
  throw checkedRpcUnsupportedError('no');
}

/** The refusal for a checked profile that resolves no daemon base URL at `connect`. */
export function checkedRpcWithoutEndpointError(): AppError {
  return checkedRpcUnsupportedError(
    'no',
    'daemonRpc checked needs a daemon base URL. Set daemonBaseUrl in the profile, or remove daemonRpc.',
  );
}

function readRefusalDetails(body: string | undefined): Record<string, unknown> {
  if (body === undefined) return {};
  try {
    const parsed: unknown = JSON.parse(body);
    const details =
      isRecord(parsed) && isRecord(parsed.error) && isRecord(parsed.error.data)
        ? parsed.error.data.details
        : undefined;
    return isRecord(details) ? details : {};
  } catch {
    return {};
  }
}

function isJsonRpcAnswer(body: string): boolean {
  try {
    const parsed: unknown = JSON.parse(body);
    return (
      isRecord(parsed) && parsed.jsonrpc === '2.0' && ('result' in parsed || 'error' in parsed)
    );
  } catch {
    return false;
  }
}

/** The body, or `undefined` when it passes `maxBytes` or the stream fails before its end. */
function readBoundedBody(res: IncomingMessage, maxBytes: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    res.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) {
        res.destroy();
        resolve(undefined);
        return;
      }
      chunks.push(chunk);
    });
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    res.on('error', () => resolve(undefined));
    res.on('aborted', () => resolve(undefined));
  });
}
