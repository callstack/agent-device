// The proxy's checked RPC admission (ADR 0006): its own protocol refusal, and the answer it builds
// when the daemon behind it refuses one. Loaded only on the checked route. Every refusal here is
// built from local values: no upstream body or header value reaches the caller.
import { randomUUID } from 'node:crypto';
import { AppError } from '@agent-device/kernel/errors';
import {
  buildCheckedRpcProtocolRefusal,
  checkedRpcProtocolRefusal,
  checkedRpcRefusalId,
  readCheckedRpcRefusalSide,
  DAEMON_HTTP_REFUSAL_HEADER,
  DAEMON_HTTP_REFUSALS,
  DAEMON_HTTP_RPC_PROTOCOL_HEADER,
  DAEMON_RPC_PROTOCOL_VERSION,
} from '@agent-device/contracts/daemon-http';

/** The most of an upstream refusal body the proxy reads for its bounded diagnostic values. */
const UPSTREAM_REFUSAL_MAX_BYTES = 64 * 1024;

/**
 * Refuses an authenticated checked call whose RPC protocol header is absent or names another
 * protocol. It runs after authentication and before the envelope check, the tenant method rules,
 * and any forwarding.
 */
export async function refuseCheckedRpcProtocol(
  request: Request,
  rpcId: unknown,
): Promise<Response | null> {
  const refusal = checkedRpcProtocolRefusal(request.headers.get(DAEMON_HTTP_RPC_PROTOCOL_HEADER));
  if (!refusal) return null;
  const { readVersion } = await import('@agent-device/host-kit/version');
  return refusalResponse(
    request,
    refusal,
    buildCheckedRpcProtocolRefusal(rpcId, refusal, {
      service: 'agent-device-proxy',
      version: readVersion(),
      rpcProtocolVersion: DAEMON_RPC_PROTOCOL_VERSION,
    }),
  );
}

/**
 * Answers the daemon's own checked refusal for it, or `null` when the upstream answer is not one.
 * A protocol refusal of the daemon is marked `upstream-protocol-mismatch`, so the client names that
 * daemon. Only the reason and the daemon's validated, bounded service, version and protocol pass;
 * the body, the id and the headers are the proxy's. A redirect is never followed or passed on.
 */
export async function localCheckedRpcRefusal(
  upstreamResponse: Response,
  request: Request,
  rpcId: unknown,
): Promise<Response | null> {
  if (
    upstreamResponse.redirected ||
    (upstreamResponse.status >= 300 && upstreamResponse.status < 400)
  ) {
    await upstreamResponse.body?.cancel();
    throw new AppError('COMMAND_FAILED', 'The daemon answered a checked call with a redirect', {
      hint: 'The proxy never follows a redirect on the checked route. Point upstreamBaseUrl at the daemon itself.',
    });
  }
  if (upstreamResponse.status !== 409) return null;
  const refusal = upstreamResponse.headers.get(DAEMON_HTTP_REFUSAL_HEADER);
  if (refusal === DAEMON_HTTP_REFUSALS.protocolMissing) {
    await upstreamResponse.body?.cancel();
    return refusalResponse(request, refusal, buildCheckedRpcProtocolRefusal(rpcId, refusal));
  }
  if (
    refusal !== DAEMON_HTTP_REFUSALS.protocolMismatch &&
    refusal !== DAEMON_HTTP_REFUSALS.upstreamProtocolMismatch
  ) {
    return null;
  }
  const side = readCheckedRpcRefusalSide(await readUpstreamRefusalDetails(upstreamResponse));
  const upstream = DAEMON_HTTP_REFUSALS.upstreamProtocolMismatch;
  return refusalResponse(request, upstream, buildCheckedRpcProtocolRefusal(rpcId, upstream, side));
}

function refusalResponse(request: Request, refusal: string, body: unknown): Response {
  return Response.json(body, {
    status: 409,
    headers: {
      [DAEMON_HTTP_REFUSAL_HEADER]: refusal,
      'x-request-id': localRequestId(request),
    },
  });
}

/** The caller's own correlation id when it is a bounded token, else a fresh one. */
function localRequestId(request: Request): string {
  const own = checkedRpcRefusalId(request.headers.get('x-request-id'));
  return typeof own === 'string' ? own : randomUUID();
}

async function readUpstreamRefusalDetails(upstreamResponse: Response): Promise<unknown> {
  const reader = upstreamResponse.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > UPSTREAM_REFUSAL_MAX_BYTES) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      error?: { data?: { details?: unknown } };
    };
    return parsed.error?.data?.details;
  } catch {
    return undefined;
  }
}
