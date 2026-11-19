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
  downloadRemoteArtifact,
  materializeRemoteArtifacts,
  type CaptureBinding,
  settleScriptDeliveryReceiptOfFailure,
} from '@agent-device/remote/daemon-artifacts';
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
    capture?: CaptureBinding;
    resolve: (response: DaemonResponse | PromiseLike<DaemonResponse>) => void;
    reject: (error: unknown) => void;
  },
): void {
  const { info, req, stateDir, host, capture, resolve, reject } = options;
  try {
    const parsed = parseDaemonHttpResponseBody(body);
    if (parsed.error) {
      void rejectDaemonHttpRpcError(parsed.error, { info, req, stateDir, capture, reject });
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
    void resolveDaemonHttpResult(
      info,
      req,
      parsed.result,
      { host, stateDir, capture },
      resolve,
      reject,
    );
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
    capture?: CaptureBinding;
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
  // #4518: a daemon refusal settles the recording grants this request bound before dispatch.
  await options.capture?.settle({ ok: false, error: payload });
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
  reject(
    appErrorFromDaemonError(
      await settleFailedDeliveryReceipt(info, req, stateDir, localized),
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
): Promise<DaemonError> {
  if (!info.baseUrl) return error;
  try {
    return await settleScriptDeliveryReceiptOfFailure(
      { baseUrl: info.baseUrl, token: info.token },
      req,
      error,
      stateDir,
      downloadRemoteArtifact,
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
  client: { host: HostEnvironment; stateDir: string; capture?: CaptureBinding },
  resolve: (response: DaemonResponse | PromiseLike<DaemonResponse>) => void,
  reject: (error: unknown) => void,
): Promise<void> {
  try {
    resolve(
      info.baseUrl && result.ok
        ? await materializeRemoteArtifacts(
            info,
            req,
            result,
            client.host,
            client.stateDir,
            client.capture,
          )
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
