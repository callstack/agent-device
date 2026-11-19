import { VPHONE_REQUIRED_METHODS } from './connection.ts';
import type { VphoneTransport } from './transport.ts';

export type VphoneTransportCall = Readonly<
  | { kind: 'json'; args: readonly string[]; timeoutMs?: number }
  | {
      kind: 'rpc';
      machine: string;
      method: string;
      params: Readonly<Record<string, unknown>>;
      timeoutMs?: number;
    }
>;

export function createRecordingVphoneTransport(
  handler: (call: VphoneTransportCall) => unknown = vphoneFixtureResponse,
) {
  const calls: VphoneTransportCall[] = [];
  const transport: VphoneTransport = Object.freeze({
    json: async (args, options) => {
      const call = {
        kind: 'json',
        args,
        ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      } as const;
      calls.push(call);
      return handler(call);
    },
    rpc: async (machine, method, params = {}, options) => {
      const call = {
        kind: 'rpc',
        machine,
        method,
        params,
        ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      } as const;
      calls.push(call);
      return handler(call);
    },
  });
  return { transport, calls };
}

export function vphoneFixtureResponse(call: VphoneTransportCall): unknown {
  if (call.kind === 'json') {
    if (call.args.join(' ') === 'vm list') {
      return [{ name: 'machine-a', state: 'running', udid: 'udid-a' }];
    }
    return { sent: true };
  }
  if (call.method === 'methods.list') {
    return { methods: VPHONE_REQUIRED_METHODS.map((name) => ({ name })) };
  }
  if (call.method === 'apps.foreground') {
    return { bundle_id: 'com.example.app', verified: true, pid: 123 };
  }
  if (call.method === 'device.screen') return { width: 390, height: 844, scale: 3 };
  if (call.method === 'ui.tree') return { elements: [] };
  return {};
}

export function rpcMethods(calls: readonly VphoneTransportCall[]): string[] {
  return calls.flatMap((call) => (call.kind === 'rpc' ? [call.method] : []));
}
