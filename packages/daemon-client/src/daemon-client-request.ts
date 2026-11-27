import type { DaemonResponse as SharedDaemonResponse } from '@agent-device/kernel/contracts';
import type { RequestProgressSink } from '@agent-device/contracts/progress';
import type { DaemonWireRequest } from '@agent-device/contracts/command';
import type { AgentDeviceDaemonTransportContext } from '@agent-device/contracts/client';

export type DaemonRequest = DaemonWireRequest;
export type DaemonResponse = SharedDaemonResponse;
export type DaemonTransportOptions = AgentDeviceDaemonTransportContext & {
  onProgress?: RequestProgressSink;
  /**
   * The request names a reused lease that no heartbeat checked, so the daemon must check it at
   * admission. A daemon whose `/health` lacks `lease-admission` is refused before the send, so the
   * request never takes the checked RPC route, which reads no `/health`.
   */
  leaseCheckedByAdmission?: true;
};

/** What a client sends one daemon request through. */
export type DaemonTransport = (
  req: Omit<DaemonRequest, 'token'>,
  options?: DaemonTransportOptions,
) => Promise<DaemonResponse>;
