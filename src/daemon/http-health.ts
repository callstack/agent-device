import { readVersion } from '../utils/version.ts';

// See docs/adr/0006-daemon-rpc-protocol-version.md before changing this value.
export const DAEMON_RPC_PROTOCOL_VERSION = 2;

export type DaemonHealthPayload = {
  ok: true;
  service: 'agent-device-daemon' | 'agent-device-proxy';
  version: string;
  rpcProtocolVersion: number;
  upstream?: unknown;
};

export function buildDaemonHealthPayload(
  service: DaemonHealthPayload['service'],
  options: { upstream?: unknown } = {},
): DaemonHealthPayload {
  return {
    ok: true,
    service,
    version: readVersion(),
    rpcProtocolVersion: DAEMON_RPC_PROTOCOL_VERSION,
    ...(options.upstream !== undefined ? { upstream: options.upstream } : {}),
  };
}
