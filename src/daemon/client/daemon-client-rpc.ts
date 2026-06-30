import { AppError, toAppErrorCode } from '../../kernel/errors.ts';
import { createRequestId } from '../../utils/diagnostics.ts';
import type { DaemonRequest, DaemonResponse } from '../types.ts';
import { materializeRemoteArtifacts } from '../../remote/daemon-artifacts.ts';
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
    resolve: (response: DaemonResponse | PromiseLike<DaemonResponse>) => void;
    reject: (error: unknown) => void;
  },
): void {
  const { info, req, resolve, reject } = options;
  try {
    const parsed = parseDaemonHttpResponseBody(body);
    if (parsed.error) {
      reject(toDaemonHttpRpcError(parsed.error, req.meta?.requestId));
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

function toDaemonHttpRpcError(
  error: { message?: string; data?: Record<string, unknown> },
  requestId: string | undefined,
): AppError {
  const data = error.data ?? {};
  return new AppError(
    toAppErrorCode(data.code != null ? String(data.code) : undefined, 'COMMAND_FAILED'),
    String(data.message ?? error.message ?? 'Daemon RPC request failed'),
    {
      ...(typeof data.details === 'object' && data.details ? data.details : {}),
      hint: typeof data.hint === 'string' ? data.hint : undefined,
      diagnosticId: typeof data.diagnosticId === 'string' ? data.diagnosticId : undefined,
      logPath: typeof data.logPath === 'string' ? data.logPath : undefined,
      requestId,
    },
  );
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
