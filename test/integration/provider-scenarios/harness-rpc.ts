import { randomUUID } from 'node:crypto';
import type { DaemonWireRequest } from '@agent-device/contracts/command';
import {
  leaseScopeFromRequest,
  leaseScopeToLeaseRpcParams,
  readLeaseAllocateProviderFlags,
} from '@agent-device/contracts/lease-scope';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import type { ProviderScenarioRpcResult } from './harness.ts';

export type JsonRpcResponseEnvelope = {
  result?: DaemonResponse;
  error?: { code: number; message: string; data?: Record<string, unknown> };
};

export function commandRequest(
  token: string,
  command: string,
  positionals: string[] = [],
  flags: DaemonWireRequest['flags'] = {},
  options: {
    input?: DaemonWireRequest['input'];
    meta?: DaemonWireRequest['meta'];
    runtime?: DaemonWireRequest['runtime'];
    session?: string;
  } = {},
): DaemonWireRequest {
  return {
    token,
    session: options.session ?? 'default',
    command,
    positionals,
    input: options.input,
    flags,
    runtime: options.runtime,
    meta: options.meta,
  };
}

function responseToRpcResult(
  response: DaemonResponse,
  id: string,
  statusCode: number,
): ProviderScenarioRpcResult {
  return {
    statusCode,
    json: response.ok
      ? {
          jsonrpc: '2.0',
          id,
          result: { data: response.data ?? {} },
        }
      : {
          jsonrpc: '2.0',
          id,
          error: {
            code: -32000,
            message: response.error.message,
            data: response.error,
          },
        },
  };
}

export function envelopeToRpcResult(
  envelope: JsonRpcResponseEnvelope,
  id: string | number,
  statusCode: number,
): ProviderScenarioRpcResult {
  if (envelope.result) return responseToRpcResult(envelope.result, String(id), statusCode);
  return {
    statusCode,
    json: {
      jsonrpc: '2.0',
      id,
      error: envelope.error ?? { code: statusCode, message: '' },
    },
  };
}

const LEASE_RPC_METHODS = {
  lease_allocate: 'agent_device.lease.allocate',
  lease_heartbeat: 'agent_device.lease.heartbeat',
  lease_release: 'agent_device.lease.release',
} as const;

/**
 * The JSON-RPC envelope a scenario posts to the daemon's `/rpc` itself: the wire a remote client
 * speaks, built independently of the client transport so a scenario can send what no client does.
 */
export function buildRpcPayload(
  req: DaemonWireRequest,
  options: { includeTokenParam: boolean },
): {
  jsonrpc: '2.0';
  id: string;
  method: string;
  params: DaemonWireRequest | Record<string, unknown>;
} {
  const id = req.meta?.requestId ?? randomUUID();
  const leaseMethod = LEASE_RPC_METHODS[req.command as keyof typeof LEASE_RPC_METHODS];
  if (!leaseMethod) return { jsonrpc: '2.0', id, method: 'agent_device.command', params: req };
  const command = req.command as keyof typeof LEASE_RPC_METHODS;
  return {
    jsonrpc: '2.0',
    id,
    method: leaseMethod,
    params: {
      ...leaseScopeToLeaseRpcParams(leaseScopeFromRequest(req), command, {
        includeTokenParam: options.includeTokenParam,
        token: req.token,
        session: req.session,
      }),
      ...(command === 'lease_allocate' ? readLeaseAllocateProviderFlags(req.flags) : {}),
      ...(command === 'lease_allocate' && req.meta?.providerCredentialFingerprint
        ? { providerCredentialFingerprint: req.meta.providerCredentialFingerprint }
        : {}),
    },
  };
}
