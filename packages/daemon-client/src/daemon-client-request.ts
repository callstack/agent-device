import type { DaemonResponse as SharedDaemonResponse } from '@agent-device/kernel/contracts';
import type { RequestProgressSink } from '@agent-device/contracts/progress';
import type { DaemonWireRequest } from '@agent-device/contracts/command';
import type { AgentDeviceDaemonTransportContext } from '@agent-device/contracts/client';

export type DaemonRequest = DaemonWireRequest;
export type DaemonResponse = SharedDaemonResponse;
export type DaemonDispatch = <T>(send: () => Promise<T>) => Promise<T>;

export type DaemonTransportOptions = AgentDeviceDaemonTransportContext & {
  onProgress?: RequestProgressSink;
  /** Runs the synchronous request handoff while the caller's admission is held. */
  dispatch?: DaemonDispatch;
  skipRemoteDiagnostics?: boolean;
};

/** What a client sends one daemon request through. */
export type DaemonTransport = (
  req: Omit<DaemonRequest, 'token'>,
  options?: DaemonTransportOptions,
) => Promise<DaemonResponse>;

/** Keeps admission through handoff and releases it while the daemon processes the request. */
export async function dispatchDaemonRequest<T>(
  dispatch: DaemonDispatch | undefined,
  send: () => T | Promise<T>,
): Promise<T> {
  if (!dispatch) return await send();
  const { result } = await dispatch(async () => {
    const result = send();
    // A transport can reject before admission finishes releasing its lock.
    if (result instanceof Promise) void result.catch(() => {});
    return { result };
  });
  return await result;
}
