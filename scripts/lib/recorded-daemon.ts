import type { DaemonWireRequest } from '@agent-device/contracts/command';
import { readRegisteredDaemon, sendDaemonRequest } from '@agent-device/daemon-client';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import type { HostEnvironment } from '@agent-device/kernel/source-value';

/** Sends to the package-admitted registration without starting, replacing or retiring a daemon. */
export async function sendToRecordedDaemon(
  request: Omit<DaemonWireRequest, 'token'>,
  options: { host: HostEnvironment; stateDir: string; timeoutMs: number; signal?: AbortSignal },
): Promise<DaemonResponse> {
  const paths = resolveDaemonPaths(options.stateDir, {
    env: options.host.env,
    cwd: options.host.cwd,
  });
  const info = await readRegisteredDaemon(paths, { required: true });
  return await sendDaemonRequest(
    info,
    { ...request, token: info.token },
    'auto',
    paths,
    options.timeoutMs,
    { host: options.host, signal: options.signal, timeoutRecovery: 'none' },
  );
}
