// May this HTTP caller reach this surface, and as which tenant? The auth hook
// (loaded from the operator's environment), the token check, the tenant-trust
// gate, and the remote-surface restrictions all answer here, for `/rpc` and
// for every auxiliary route that shares the same gate.
import http, { type IncomingHttpHeaders } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AppError, normalizeError, toAppErrorCode } from '@agent-device/kernel/errors';
import { timingSafeStringEqual } from '@agent-device/host-kit/transport';
import type { DaemonRequest } from '../daemon-request.ts';
import { normalizeTenantId } from '../config.ts';
import {
  DAEMON_HTTP_PUBLIC_NETWORK_ACCESS,
  DAEMON_HTTP_TENANT_HEADER,
} from '@agent-device/contracts/daemon-http';
import { sendRestJsonError } from '../http-errors.ts';
import { resolveTrustedTenant, tenantTrustRejectionError } from './tenant-trust.ts';
import type { TenantSessionNamespace } from '../session-tenant-scope.ts';
import type { LeaseRegistry } from '../lease-registry.ts';
import { assertMacOsAppLeaseTenantMayReadDiagnostics } from '../macos-app-lease.ts';
import { createRpcError } from './http-rpc-envelope.ts';
import type { JsonRpcRequest, JsonRpcResponse } from './http-rpc-envelope.ts';

export type HttpAuthHookContext = {
  headers: IncomingHttpHeaders;
  rpcRequest: JsonRpcRequest;
  daemonRequest: DaemonRequest;
};

export type HttpAuthHookResult =
  | boolean
  | void
  | {
      ok?: boolean;
      tenantId?: string;
      code?: string;
      message?: string;
      details?: Record<string, unknown>;
    };

export type HttpAuthHook = (
  context: HttpAuthHookContext,
) => Promise<HttpAuthHookResult> | HttpAuthHookResult;

type HttpAuthDecision =
  | { ok: true; tenantId?: string }
  | { ok: false; statusCode: number; response: JsonRpcResponse };

function restrictRemoteHttpRequest(
  request: DaemonRequest,
  authHookConfigured: boolean,
  networkAccessMarker: string | string[] | undefined,
): DaemonRequest {
  if (
    networkAccessMarker !== undefined &&
    networkAccessMarker !== DAEMON_HTTP_PUBLIC_NETWORK_ACCESS
  ) {
    throw new AppError('INVALID_ARGS', 'Invalid daemon HTTP network access marker');
  }
  if (!authHookConfigured && networkAccessMarker === undefined) return request;
  const source = request.meta?.installSource;
  const uploadedArtifactId = request.meta?.uploadedArtifactId;
  if (
    source?.kind === 'path' &&
    !(typeof uploadedArtifactId === 'string' && uploadedArtifactId.length > 0)
  ) {
    throw new AppError(
      'INVALID_ARGS',
      'Invalid params: path install sources are disabled on the remote HTTP surface',
    );
  }
  // A developer dir is a host path whose tools the daemon would run, and a credential fingerprint
  // would let a remote caller probe the daemon's credentials. A daemon with an auth hook serves
  // remote callers and runs on its operator's credentials, so it treats every caller as remote.
  const {
    developerDir: _developerDir,
    providerCredentialFingerprint: _providerCredentialFingerprint,
    ...meta
  } = request.meta ?? {};
  return {
    ...request,
    ...(request.meta ? { meta } : {}),
    internal: { ...request.internal, publicNetworkOnly: true },
  };
}

async function runHttpAuthHook(
  authHook: HttpAuthHook | null,
  context: HttpAuthHookContext,
): Promise<HttpAuthDecision> {
  if (!authHook) return { ok: true };
  const result = await authHook(context);
  if (result === undefined || result === true) return { ok: true };
  const reject = (statusCode: number, rpcCode: number, error: AppError): HttpAuthDecision => {
    const normalized = normalizeError(error);
    return {
      ok: false,
      statusCode,
      response: createRpcError(
        context.rpcRequest.id ?? null,
        rpcCode,
        normalized.message,
        normalized,
      ),
    };
  };
  if (result === false || result.ok === false) {
    const rejected = result === false ? {} : result;
    return reject(
      401,
      -32001,
      new AppError(
        toAppErrorCode(rejected.code, 'UNAUTHORIZED'),
        rejected.message ?? 'Request rejected by auth hook',
        rejected.details,
      ),
    );
  }
  if (typeof result.tenantId === 'string' && result.tenantId.length > 0) {
    const tenantId = normalizeTenantId(result.tenantId);
    if (!tenantId) {
      return reject(
        500,
        -32000,
        new AppError('INVALID_ARGS', 'Auth hook returned invalid tenantId'),
      );
    }
    return { ok: true, tenantId };
  }
  return { ok: true };
}

async function loadHttpAuthHook(
  env: NodeJS.ProcessEnv = process.env,
): Promise<HttpAuthHook | null> {
  const hookPath = env.AGENT_DEVICE_HTTP_AUTH_HOOK;
  if (!hookPath) return null;
  const exportName = env.AGENT_DEVICE_HTTP_AUTH_EXPORT || 'default';
  const resolvedPath = path.isAbsolute(hookPath) ? hookPath : path.resolve(hookPath);
  let imported: Record<string, unknown>;
  try {
    imported = (await import(pathToFileURL(resolvedPath).href)) as Record<string, unknown>;
  } catch (error) {
    throw new AppError('COMMAND_FAILED', 'Failed to load AGENT_DEVICE_HTTP_AUTH_HOOK module', {
      hookPath: resolvedPath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const maybeHook = imported[exportName];
  if (typeof maybeHook !== 'function') {
    throw new AppError('INVALID_ARGS', `Auth hook export ${exportName} is not a function`, {
      hookPath: resolvedPath,
      exportName,
    });
  }
  return maybeHook as HttpAuthHook;
}

function resolveToken(params: Record<string, unknown>, headers: IncomingHttpHeaders): string {
  const authHeader = typeof headers.authorization === 'string' ? headers.authorization : '';
  const bearerToken = authHeader.toLowerCase().startsWith('bearer ')
    ? authHeader.slice('bearer '.length)
    : undefined;
  const headerToken =
    typeof headers['x-agent-device-token'] === 'string'
      ? headers['x-agent-device-token']
      : undefined;
  const paramToken = typeof params.token === 'string' ? params.token : undefined;
  return paramToken ?? headerToken ?? bearerToken ?? '';
}

/**
 * The token/auth-hook gate every non-RPC route shares. `sessionNamespace` is the
 * naming precondition the session-addressed routes need: present only when the
 * caller carries a tenant at all, and `partitioned` exactly when that tenant is
 * attested, which is the same condition the `/rpc` handler turns into
 * `sessionIsolation: 'tenant'`.
 */
async function authorizeAuxiliaryHttpRequest(params: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  authHook: HttpAuthHook | null;
  expectedToken?: string;
  daemonRequest: Pick<DaemonRequest, 'command' | 'positionals'>;
}): Promise<{ tenantId?: string; sessionNamespace?: TenantSessionNamespace } | null> {
  const { req, res, authHook, expectedToken, daemonRequest } = params;
  const token = resolveToken({}, req.headers);
  const tenantId = normalizeTenantId(readHeaderValue(req.headers, DAEMON_HTTP_TENANT_HEADER));
  const tokenError = enforceDaemonToken(token, expectedToken);
  if (tokenError) {
    sendRestJsonError(res, tokenError);
    return null;
  }

  const syntheticRpc: JsonRpcRequest = {
    jsonrpc: '2.0',
    id: null,
    method: 'agent_device.command',
  };
  const authResult = await runHttpAuthHook(authHook, {
    headers: req.headers,
    rpcRequest: syntheticRpc,
    daemonRequest: {
      token,
      session: 'default',
      command: daemonRequest.command,
      positionals: daemonRequest.positionals,
      ...(tenantId ? { meta: { tenantId } } : {}),
    },
  });
  if (!authResult.ok) {
    sendAuxiliaryAuthHookRejection(res, authResult);
    return null;
  }

  const tenantTrust = resolveTrustedTenant({
    hookConfigured: authHook !== null,
    hookAttestedTenant: authResult.tenantId,
    clientDeclaredTenant: tenantId,
  });
  if (!tenantTrust.trusted) {
    sendRestJsonError(res, tenantTrustRejectionError());
    return null;
  }

  const trustedTenant = tenantTrust.tenantId;
  return {
    tenantId: trustedTenant,
    ...(trustedTenant
      ? { sessionNamespace: { tenant: trustedTenant, partitioned: tenantTrust.attested } }
      : {}),
  };
}

async function authorizeDiagnosticsHttpRequest(
  params: Parameters<typeof authorizeAuxiliaryHttpRequest>[0] & { leaseRegistry?: LeaseRegistry },
): ReturnType<typeof authorizeAuxiliaryHttpRequest> {
  const { leaseRegistry, ...gate } = params;
  const auth = await authorizeAuxiliaryHttpRequest(gate);
  if (!auth || !leaseRegistry) return auth;
  try {
    assertMacOsAppLeaseTenantMayReadDiagnostics(leaseRegistry, auth.tenantId);
  } catch (error) {
    sendRestJsonError(gate.res, normalizeError(error));
    return null;
  }
  return auth;
}

/**
 * An auth hook's own rejection, rendered as the flat REST error these routes
 * answer with rather than the JSON-RPC envelope the hook decision carries.
 */
function sendAuxiliaryAuthHookRejection(
  res: http.ServerResponse,
  decision: Extract<HttpAuthDecision, { ok: false }>,
): void {
  res.statusCode = decision.statusCode;
  res.setHeader('content-type', 'application/json');
  res.end(
    JSON.stringify({
      ok: false,
      error:
        decision.response.error?.data?.message ??
        decision.response.error?.message ??
        'Unauthorized',
    }),
  );
}

function readHeaderValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return typeof value === 'string' ? value : undefined;
}

function enforceDaemonToken(
  requestToken: string,
  expectedToken: string | undefined,
): ReturnType<typeof normalizeError> | null {
  if (!expectedToken) return null;
  if (timingSafeStringEqual(requestToken, expectedToken)) return null;
  return normalizeError(new AppError('UNAUTHORIZED', 'Invalid token'));
}

export {
  authorizeAuxiliaryHttpRequest,
  authorizeDiagnosticsHttpRequest,
  enforceDaemonToken,
  loadHttpAuthHook,
  restrictRemoteHttpRequest,
  resolveToken,
  runHttpAuthHook,
};
