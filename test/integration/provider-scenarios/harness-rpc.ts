import type { DaemonWireRequest } from '@agent-device/contracts/command';
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
