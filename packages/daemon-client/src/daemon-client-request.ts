import type { DaemonResponse as SharedDaemonResponse } from '@agent-device/kernel/contracts';
import type { RequestProgressSink } from '@agent-device/contracts/progress';
import type { DaemonWireRequest } from '@agent-device/contracts/command';
import type { AgentDeviceDaemonTransportContext } from '@agent-device/contracts/client';

export type DaemonRequest = DaemonWireRequest;
export type DaemonResponse = SharedDaemonResponse;
export type DaemonTransportOptions = AgentDeviceDaemonTransportContext & {
  onProgress?: RequestProgressSink;
};

/** What a client sends one daemon request through. */
export type DaemonTransport = (
  req: Omit<DaemonRequest, 'token'>,
  options?: DaemonTransportOptions,
) => Promise<DaemonResponse>;
