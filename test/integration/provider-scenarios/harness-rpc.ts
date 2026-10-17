import type { DaemonWireRequest } from '@agent-device/contracts/command';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import type { ProviderScenarioRpcResult } from './harness.ts';

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

export function responseToRpcResult(
  response: DaemonResponse,
  id: string,
): ProviderScenarioRpcResult {
  return {
    statusCode: 200,
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
