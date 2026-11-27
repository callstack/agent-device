// The client half of the checked RPC route (ADR 0006): what a refusal or an unknown-route answer
// means for the caller, and the `connect` check that the remote serves the route at all. Loaded only
// on those paths, so a command that gets its answer never pays for it.
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { AppError, discloseUnclassifiedDispatch } from '@agent-device/kernel/errors';
import { isRecord } from '@agent-device/kernel/record';
import {
  DAEMON_CHECKED_RPC_REASONS,
  DAEMON_HTTP_REFUSAL_HEADER,
  DAEMON_HTTP_REFUSALS,
} from '@agent-device/contracts/daemon-http';
import { assertScriptArtifactsCapability } from '@agent-device/daemon-contracts/daemon-resolution';
import type { DaemonInfo } from './daemon-client-metadata.ts';
import { incompatibleRemoteProtocolError } from './daemon-client-rpc.ts';
import { readHealthLink, readRemoteDaemonHealth } from './daemon-client-transport.ts';
import { remoteDaemonUnavailableError } from './daemon-lifecycle-errors.ts';

/** The most of a refusal body the client reads: its metadata is a few short fields. */
const REFUSAL_BODY_MAX_BYTES = 64 * 1024;
/** The most of a 404 body the client reads to tell a daemon's JSON-RPC answer from a route miss. */
const NOT_FOUND_BODY_MAX_BYTES = 1024 * 1024;

const UNSUPPORTED_HINT =
  'The remote daemon or proxy does not serve checked RPC. Update it, or remove daemonRpc from the connection profile (or pass --daemon-rpc health).';

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
  info: DaemonInfo,
): Promise<CheckedRpcOutcome> {
  const notFound = res.statusCode === 404;
  const body = await readBoundedBody(
    res,
    notFound ? NOT_FOUND_BODY_MAX_BYTES : REFUSAL_BODY_MAX_BYTES,
  );
  if (notFound) {
    return body !== undefined && isJsonRpcAnswer(body)
      ? { kind: 'answer', body }
      : { kind: 'refused', error: checkedRpcUnsupportedError(info, 'unknown') };
  }
  return {
    kind: 'refused',
    error: checkedRpcRefusalError(String(res.headers[DAEMON_HTTP_REFUSAL_HEADER]), body, info),
  };
}

function checkedRpcRefusalError(
  refusal: string,
  body: string | undefined,
  info: DaemonInfo,
): AppError {
  switch (refusal) {
    case DAEMON_HTTP_REFUSALS.protocolMismatch:
    case DAEMON_HTTP_REFUSALS.upstreamProtocolMismatch:
      return discloseUnclassifiedDispatch(protocolMismatchError(refusal, body, info), 'no');
    case DAEMON_HTTP_REFUSALS.scriptArtifacts:
      return discloseUnclassifiedDispatch(scriptArtifactsError(), 'no');
    default:
      return new AppError(
        'COMMAND_FAILED',
        'The remote refused the checked RPC call because it named no RPC protocol',
        {
          reason: DAEMON_CHECKED_RPC_REASONS.protocolMissing.reason,
          dispatched: 'no',
          daemonBaseUrl: info.baseUrl,
          hint: 'An ingress between this client and the remote removes the x-agent-device-rpc-protocol header. Fix that ingress, or remove daemonRpc from the connection profile.',
        },
      );
  }
}

/** Today's upgrade message, built from the refusing side's bounded and validated metadata. */
function protocolMismatchError(
  refusal: string,
  body: string | undefined,
  info: DaemonInfo,
): AppError {
  const link = readHealthLink(readRefusalDetails(body));
  const behindProxy = refusal === DAEMON_HTTP_REFUSALS.upstreamProtocolMismatch;
  if (typeof link.rpcProtocolVersion === 'number' && Number.isInteger(link.rpcProtocolVersion)) {
    return incompatibleRemoteProtocolError(
      info.baseUrl ?? '',
      { ...link, rpcProtocolVersion: link.rpcProtocolVersion },
      behindProxy ? { service: 'agent-device-proxy' } : undefined,
    );
  }
  return new AppError('COMMAND_FAILED', 'Remote daemon RPC protocol is incompatible', {
    reason: DAEMON_CHECKED_RPC_REASONS.protocolMismatch.reason,
    daemonBaseUrl: info.baseUrl,
    hint: 'Upgrade agent-device so this client and the remote speak the same RPC protocol.',
  });
}

function scriptArtifactsError(): AppError {
  try {
    assertScriptArtifactsCapability(undefined);
  } catch (error) {
    if (error instanceof AppError) return error;
  }
  throw new Error('assertScriptArtifactsCapability accepted no capabilities');
}

/** The typed failure when the remote does not serve checked RPC. A command is never resent. */
function checkedRpcUnsupportedError(info: DaemonInfo, dispatched: 'no' | 'unknown'): AppError {
  return new AppError('COMMAND_FAILED', 'The remote does not serve checked RPC', {
    reason: DAEMON_CHECKED_RPC_REASONS.routeUnsupported.reason,
    dispatched,
    daemonBaseUrl: info.baseUrl,
    hint: UNSUPPORTED_HINT,
  });
}

/**
 * Refuses `daemonRpc: checked` at `connect` unless every link the command RPC crosses advertises the
 * `checked-rpc` capability: the endpoint, and the daemon behind it when the endpoint is a proxy.
 */
export async function assertRemoteServesCheckedRpc(params: {
  baseUrl: string;
  token: string | undefined;
}): Promise<void> {
  const info: DaemonInfo = { token: params.token ?? '', pid: 0, baseUrl: params.baseUrl };
  const health = await readRemoteDaemonHealth(info);
  if (!health.reachable) {
    throw remoteDaemonUnavailableError({ daemonBaseUrl: params.baseUrl, attempts: 1 });
  }
  if (health.checkedRpc && (!health.upstream || health.upstream.checkedRpc)) return;
  throw checkedRpcUnsupportedError(info, 'no');
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
