import { INTERNAL_COMMANDS } from '@agent-device/command-registry/catalog';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import type { DaemonWireRequest } from '@agent-device/contracts/command';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import {
  AppError,
  asAppError,
  readDiagnosticsRecordRef,
  toAppErrorCode,
  type DaemonError,
} from '@agent-device/kernel/errors';
import { sanitizeErrorCause } from '@agent-device/kernel/redaction';
import { createRequestId } from '@agent-device/host-kit/diagnostics';
import { materializeRemoteArtifacts } from '@agent-device/remote/daemon-artifacts';
import { localizeRemoteDaemonError } from '@agent-device/remote/remote-request-diagnostics';
import type { DaemonInfo } from './daemon-client-metadata.ts';
import { DAEMON_REQUEST_MAX_BYTES } from '@agent-device/contracts/daemon-http';
import { buildDaemonRpcRequest, leaseScopeFromRequest } from '@agent-device/contracts/lease-scope';

export function handleDaemonHttpResponseBody(
  body: string,
  options: {
    info: DaemonInfo;
    req: DaemonWireRequest;
    stateDir: string;
    host: HostEnvironment;
    resolve: (response: DaemonResponse | PromiseLike<DaemonResponse>) => void;
    reject: (error: unknown) => void;
  },
): void {
  const { info, req, stateDir, host, resolve, reject } = options;
  try {
    const parsed = parseDaemonHttpResponseBody(body);
    if (parsed.error) {
      void rejectDaemonHttpRpcError(parsed.error, { info, req, stateDir, reject });
      return;
    }
    if (!parsed.result || typeof parsed.result !== 'object') {
      reject(
        new AppError('COMMAND_FAILED', 'Invalid daemon RPC response', {
          requestId: req.meta?.requestId,
          reason: 'daemon_response_invalid',
        }),
      );
      return;
    }
    void resolveDaemonHttpResult(info, req, parsed.result, host, resolve, reject);
  } catch (err) {
    reject(
      new AppError(
        'COMMAND_FAILED',
        'Invalid daemon response',
        {
          requestId: req.meta?.requestId,
          reason: 'daemon_response_invalid',
          line: body,
        },
        err instanceof Error ? err : undefined,
      ),
    );
  }
}

function parseDaemonHttpResponseBody(body: string): {
  result?: DaemonResponse;
  error?: { message?: string; data?: Record<string, unknown> };
} {
  return JSON.parse(body) as {
    result?: DaemonResponse;
    error?: { message?: string; data?: Record<string, unknown> };
  };
}

/**
 * #1801: a REMOTE daemon's error names a `logPath` on ITS host, so the failure
 * is rehydrated only after that record has been made readable here — the error
 * the caller sees then names a caller-local copy, or no path at all. A local
 * daemon shares the filesystem, so its error is rehydrated as-is.
 */
async function rejectDaemonHttpRpcError(
  error: { message?: string; data?: Record<string, unknown> },
  options: {
    info: DaemonInfo;
    req: DaemonWireRequest;
    stateDir: string;
    reject: (error: unknown) => void;
  },
): Promise<void> {
  const { info, req, stateDir, reject } = options;
  const requestId = req.meta?.requestId;
  const payload = toDaemonHttpRpcError(error);
  if (!info.baseUrl) {
    reject(appErrorFromDaemonError(payload, requestId));
    return;
  }
  const localized = await localizeRemoteDaemonError(payload, {
    endpoint: {
      baseUrl: info.baseUrl,
      token: info.token,
      tenantId: req.meta?.tenantId,
      leaseId: leaseScopeFromRequest(req).leaseId,
    },
    stateDir,
    requestId,
  });
  reject(appErrorFromDaemonError(localized, requestId));
}

function toDaemonHttpRpcError(error: {
  message?: string;
  data?: Record<string, unknown>;
}): DaemonError {
  const data = error.data ?? {};
  const cause = readDaemonErrorCause(data.cause);
  return {
    code: toAppErrorCode(data.code != null ? String(data.code) : undefined, 'COMMAND_FAILED'),
    message: String(data.message ?? error.message ?? 'Daemon RPC request failed'),
    cause,
    details:
      typeof data.details === 'object' && data.details
        ? (data.details as Record<string, unknown>)
        : undefined,
    hint: typeof data.hint === 'string' ? data.hint : undefined,
    diagnosticId: typeof data.diagnosticId === 'string' ? data.diagnosticId : undefined,
    logPath: typeof data.logPath === 'string' ? data.logPath : undefined,
    diagnosticsRecord: readDiagnosticsRecordRef(data.diagnosticsRecord),
    retriable: typeof data.retriable === 'boolean' ? data.retriable : undefined,
    supportedOn: typeof data.supportedOn === 'string' ? data.supportedOn : undefined,
  };
}

function readDaemonErrorCause(value: unknown): DaemonError['cause'] {
  return sanitizeErrorCause(value);
}

function appErrorFromDaemonError(error: DaemonError, requestId: string | undefined): AppError {
  return new AppError(
    toAppErrorCode(error.code, 'COMMAND_FAILED'),
    error.message,
    {
      ...(error.details ?? {}),
      hint: error.hint,
      diagnosticId: error.diagnosticId,
      logPath: error.logPath,
      logPathUnavailable: error.logPathUnavailable,
      diagnosticsRecord: error.diagnosticsRecord,
      retriable: error.retriable,
      supportedOn: error.supportedOn,
      requestId,
    },
    error.cause,
  );
}

async function resolveDaemonHttpResult(
  info: DaemonInfo,
  req: DaemonWireRequest,
  result: DaemonResponse,
  host: HostEnvironment,
  resolve: (response: DaemonResponse | PromiseLike<DaemonResponse>) => void,
  reject: (error: unknown) => void,
): Promise<void> {
  try {
    resolve(
      info.baseUrl && result.ok
        ? await materializeRemoteArtifacts(info, req, result, host)
        : result,
    );
  } catch (error) {
    // The daemon answered, so the request ran; only bringing its artifacts here failed.
    reject(await discloseAnsweredRequestFailure(error, req));
  }
}

/** Never throws, so the request settles even if the disclosure module cannot load. */
async function discloseAnsweredRequestFailure(
  error: unknown,
  req: DaemonWireRequest,
): Promise<unknown> {
  try {
    const { discloseRequestFailure } = await import('./daemon-client-dispatch-disclosure.ts');
    return discloseRequestFailure(asAppError(error), req, true);
  } catch {
    return error;
  }
}

export function buildHttpRpcPayload(
  req: DaemonWireRequest,
  options: { includeTokenParam: boolean },
): ReturnType<typeof buildDaemonRpcRequest> {
  return buildDaemonRpcRequest(req, {
    id: req.meta?.requestId ?? createRequestId(),
    includeTokenParam: options.includeTokenParam,
  });
}

/** Throws before sending a serialized request that no daemon transport would read. */
export function refuseOversizedDaemonRequest(payload: string, requestId: string | undefined): void {
  const requestBytes = Buffer.byteLength(payload, 'utf8');
  if (requestBytes <= DAEMON_REQUEST_MAX_BYTES) return;
  throw new AppError('INVALID_ARGS', 'Daemon request exceeds the size limit', {
    reason: 'daemon_request_too_large',
    requestBytes,
    maxBytes: DAEMON_REQUEST_MAX_BYTES,
    requestId,
    daemonRequestSent: false,
    hint: 'Split the replay suite or flow into smaller runs.',
  });
}

/** Refuse unsupported script output before any mutating RPC, including after instance retry. */
export function assertRemoteActiveScriptArtifacts(info: DaemonInfo, req: DaemonWireRequest): void {
  if (
    info.baseUrl &&
    !info.capabilities?.includes('active-script-artifacts') &&
    (req.flags?.saveScript || req.command === INTERNAL_COMMANDS.sessionSaveScript)
  ) {
    throw new AppError(
      'INVALID_ARGS',
      'The remote daemon does not support downloadable session scripts.',
      {
        reason: 'remote_active_script_artifacts_unsupported',
        daemonRequestSent: false,
        hint: 'Use a daemon and proxy that advertise the active-script-artifacts capability in the upstream health response. Keep the owning integration in control of upgrades.',
      },
    );
  }
}
