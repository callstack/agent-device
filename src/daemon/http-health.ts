import { readVersion } from '../utils/version.ts';

// See docs/adr/0006-daemon-rpc-protocol-version.md before changing this value.
// Enforced, not just documented: `test/wire-compat/` digests the declarations
// that cross this boundary and fails when one changes shape without a bump or
// an acknowledged-compatible entry (#1432).
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
