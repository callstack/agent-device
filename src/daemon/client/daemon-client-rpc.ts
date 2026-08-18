import {
  AppError,
  readDiagnosticsRecordRef,
  toAppErrorCode,
  type DaemonError,
} from '@agent-device/kernel/errors';
import { createRequestId } from '../../utils/diagnostics.ts';
import type { DaemonRequest, DaemonResponse } from '../types.ts';
import { materializeRemoteArtifacts } from '../../remote/daemon-artifacts.ts';
import { localizeRemoteDaemonError } from '../../remote/remote-request-diagnostics.ts';
import type { DaemonInfo } from './daemon-client-metadata.ts';
import {
  leaseScopeFromRequest,
  leaseScopeToLeaseRpcParams,
  type LeaseRpcCommand,
} from '../../core/lease-scope.ts';

export function handleDaemonHttpResponseBody(
  body: string,
  options: {
    info: DaemonInfo;
    req: DaemonRequest;
    stateDir: string;
    resolve: (response: DaemonResponse | PromiseLike<DaemonResponse>) => void;
    reject: (error: unknown) => void;
  },
): void {
  const { info, req, stateDir, resolve, reject } = options;
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
        }),
      );
      return;
    }
    void resolveDaemonHttpResult(info, req, parsed.result, resolve, reject);
  } catch (err) {
    reject(
      new AppError(
        'COMMAND_FAILED',
        'Invalid daemon response',
        {
          requestId: req.meta?.requestId,
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
    req: DaemonRequest;
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
    endpoint: { baseUrl: info.baseUrl, token: info.token, tenantId: req.meta?.tenantId },
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
  return {
    code: toAppErrorCode(data.code != null ? String(data.code) : undefined, 'COMMAND_FAILED'),
    message: String(data.message ?? error.message ?? 'Daemon RPC request failed'),
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

function appErrorFromDaemonError(error: DaemonError, requestId: string | undefined): AppError {
  return new AppError(toAppErrorCode(error.code, 'COMMAND_FAILED'), error.message, {
    ...(error.details ?? {}),
    hint: error.hint,
    diagnosticId: error.diagnosticId,
    logPath: error.logPath,
    logPathUnavailable: error.logPathUnavailable,
    diagnosticsRecord: error.diagnosticsRecord,
    retriable: error.retriable,
    supportedOn: error.supportedOn,
    requestId,
  });
}

async function resolveDaemonHttpResult(
  info: DaemonInfo,
  req: DaemonRequest,
  result: DaemonResponse,
  resolve: (response: DaemonResponse | PromiseLike<DaemonResponse>) => void,
  reject: (error: unknown) => void,
): Promise<void> {
  try {
    resolve(
      info.baseUrl && result.ok ? await materializeRemoteArtifacts(info, req, result) : result,
    );
  } catch (error) {
    reject(error);
  }
}

export function buildHttpRpcPayload(
  req: DaemonRequest,
  options: { includeTokenParam: boolean },
): {
  jsonrpc: '2.0';
  id: string;
  method: string;
  params: DaemonRequest | Record<string, unknown>;
} {
  const id = req.meta?.requestId ?? createRequestId();
  if (!isLeaseRpcCommand(req.command)) {
    return {
      jsonrpc: '2.0',
      id,
      method: 'agent_device.command',
      params: req,
    };
  }
  return {
    jsonrpc: '2.0',
    id,
    method: leaseRpcMethodForCommand(req.command),
    params: buildLeaseRpcParams(req, req.command, options),
  };
}

function isLeaseRpcCommand(command: string): command is LeaseRpcCommand {
  return (
    command === 'lease_allocate' || command === 'lease_heartbeat' || command === 'lease_release'
  );
}

function leaseRpcMethodForCommand(command: LeaseRpcCommand): string {
  switch (command) {
    case 'lease_allocate':
      return 'agent_device.lease.allocate';
    case 'lease_heartbeat':
      return 'agent_device.lease.heartbeat';
    case 'lease_release':
      return 'agent_device.lease.release';
  }
}

function buildLeaseRpcParams(
  req: DaemonRequest,
  command: LeaseRpcCommand,
  options: { includeTokenParam: boolean },
): Record<string, unknown> {
  return leaseScopeToLeaseRpcParams(leaseScopeFromRequest(req), command, {
    includeTokenParam: options.includeTokenParam,
    token: req.token,
    session: req.session,
  });
}
