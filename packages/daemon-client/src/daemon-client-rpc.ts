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
import {
  fetchRemoteArtifact,
  materializeRemoteArtifacts,
  projectRemoteErrorDetails,
  settleScriptDeliveryReceiptOfFailure,
} from '@agent-device/remote/daemon-artifacts';
import { localizeRemoteDaemonError } from '@agent-device/remote/remote-request-diagnostics';
import { isRemoteDaemon, type DaemonInfo } from './daemon-client-metadata.ts';
import { DAEMON_REQUEST_MAX_BYTES } from '@agent-device/contracts/daemon-http';
import { isRecord } from '@agent-device/kernel/record';
import { buildDaemonRpcRequest, leaseScopeFromRequest } from '@agent-device/contracts/lease-scope';

export function handleDaemonHttpResponseBody(
  body: string,
  options: {
    info: DaemonInfo;
    req: DaemonWireRequest;
    stateDir: string;
    host: HostEnvironment;
    /** The caller's cancellation, which still stops artifact delivery after the answer arrived. */
    signal?: AbortSignal;
    /** Called once artifact delivery, which observes `signal`, takes over the caller abort. */
    onDelivery?: () => void;
    resolve: (response: DaemonResponse | PromiseLike<DaemonResponse>) => void;
    reject: (error: unknown) => void;
  },
): void {
  const { info, req, stateDir, host, signal, onDelivery, resolve, reject } = options;
  try {
    const parsed = parseDaemonHttpResponseBody(body);
    if (parsed.error) {
      rejectDaemonHttpRpcError(parsed.error, { info, req, stateDir, signal, reject }).catch(reject);
      return;
    }
    const result: unknown = parsed.result;
    if (!isRemoteDaemon(info)) {
      if (typeof result === 'object' && result !== null) resolve(result as DaemonResponse);
      else reject(invalidDaemonResponse(req));
      return;
    }
    // #4518: a remote answer is classified once, by one predicate. Only a result whose `ok` is
    // exactly `true` is delivered. Any other result with an `error` object leaves through the error
    // path, which strips client-owned fields and localizes the log. Every other result is invalid.
    if (isDeliverableResult(result)) {
      void resolveDaemonHttpResult(
        info,
        req,
        result,
        { host, stateDir, signal, onDelivery },
        resolve,
        reject,
      );
    } else if (isRecord(result) && isRecord(result.error)) {
      const message = typeof result.error.message === 'string' ? result.error.message : undefined;
      rejectDaemonHttpRpcError(
        { message, data: result.error },
        { info, req, stateDir, signal, reject },
      ).catch(reject);
    } else {
      reject(invalidDaemonResponse(req));
    }
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

function isDeliverableResult(value: unknown): value is Extract<DaemonResponse, { ok: true }> {
  return isRecord(value) && value.ok === true;
}

function invalidDaemonResponse(req: DaemonWireRequest): AppError {
  return new AppError('COMMAND_FAILED', 'Invalid daemon RPC response', {
    requestId: req.meta?.requestId,
    reason: 'daemon_response_invalid',
  });
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
    signal?: AbortSignal;
    reject: (error: unknown) => void;
  },
): Promise<void> {
  const { info, req, stateDir, signal, reject } = options;
  const requestId = req.meta?.requestId;
  const local = toDaemonHttpRpcError(error);
  if (!info.baseUrl) {
    reject(appErrorFromDaemonError(local, requestId));
    return;
  }
  // A remote peer cannot supply the fields only this client's own delivery sets (#4518).
  const payload = { ...local, details: await projectRemoteErrorDetails(req, local.details) };
  // A caller abort already rejected this request, so no diagnostics record is fetched for it.
  if (signal?.aborted) {
    reject(appErrorFromDaemonError({ ...payload, logPath: undefined }, requestId));
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
    signal,
  });
  reject(
    appErrorFromDaemonError(
      await settleFailedDeliveryReceipt(info, req, stateDir, localized, signal),
      requestId,
    ),
  );
}

/**
 * Settles the batch delivery receipt (#4595) a failed remote answer names: a batch that stopped
 * mid-plan still delivers what its completed steps wrote, and the disclosure rides the error the
 * caller receives. Never throws, so a receipt that cannot settle still leaves the original failure.
 */
async function settleFailedDeliveryReceipt(
  info: DaemonInfo,
  req: DaemonWireRequest,
  stateDir: string,
  error: DaemonError,
  signal: AbortSignal | undefined,
): Promise<DaemonError> {
  // A caller abort already rejected this request, so nothing is delivered for it any more.
  if (!info.baseUrl || signal?.aborted) return error;
  try {
    return await settleScriptDeliveryReceiptOfFailure(
      { baseUrl: info.baseUrl, token: info.token },
      req,
      error,
      stateDir,
      fetchRemoteArtifact,
      signal,
    );
  } catch {
    return error;
  }
}

function toDaemonHttpRpcError(error: {
  message?: string;
  data?: Record<string, unknown>;
}): DaemonError {
  const data = error.data ?? {};
  const cause = readDaemonErrorCause(data.cause);
  return {
    code: toAppErrorCode(typeof data.code === 'string' ? data.code : undefined, 'COMMAND_FAILED'),
    message:
      typeof data.message === 'string'
        ? data.message
        : typeof error.message === 'string'
          ? error.message
          : 'Daemon RPC request failed',
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

/** Delivers a remote success answer: artifact delivery takes over the caller abort first. */
async function resolveDaemonHttpResult(
  info: DaemonInfo,
  req: DaemonWireRequest,
  result: Extract<DaemonResponse, { ok: true }>,
  client: {
    host: HostEnvironment;
    stateDir: string;
    signal?: AbortSignal;
    onDelivery?: () => void;
  },
  resolve: (response: DaemonResponse | PromiseLike<DaemonResponse>) => void,
  reject: (error: unknown) => void,
): Promise<void> {
  try {
    client.onDelivery?.();
    resolve(
      await materializeRemoteArtifacts(
        info,
        req,
        result,
        client.host,
        client.stateDir,
        client.signal,
      ),
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
