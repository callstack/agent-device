import type { DaemonWireRequest } from '@agent-device/contracts/command';
import { sendDaemonRequest } from '@agent-device/daemon-client';
import {
  readDaemonRecord,
  resolveDaemonPaths,
} from '@agent-device/daemon-contracts/daemon-resolution';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import type { HostEnvironment } from '@agent-device/kernel/source-value';

/**
 * The registration a state directory records, as the measurement and live-lane tooling reads it.
 * It is the part of a daemon record that `sendDaemonRequest` needs to reach that daemon.
 */
export type RecordedDaemon = Readonly<{
  pid: number;
  token: string;
  port?: number;
  httpPort?: number;
  processStartTime?: string;
}>;

export function readRecordedDaemon(infoPath: string): RecordedDaemon | null {
  const read = readDaemonRecord(infoPath);
  if (read.status !== 'present') return null;
  const { pid, token, port, httpPort, processStartTime } = read.record;
  if (typeof pid !== 'number' || typeof token !== 'string') return null;
  return {
    pid,
    token,
    ...(typeof port === 'number' ? { port } : {}),
    ...(typeof httpPort === 'number' ? { httpPort } : {}),
    ...(typeof processStartTime === 'string' ? { processStartTime } : {}),
  };
}

/**
 * Sends one request to the daemon a state directory records, through the client transport. The
 * tooling that calls this drives a daemon another build started, so it resolves the record and
 * nothing else: no daemon is started, replaced or compatibility-checked, and a timeout never
 * retires the daemon (`timeoutRecovery: 'none'`).
 */
export async function sendToRecordedDaemon(
  request: Omit<DaemonWireRequest, 'token'>,
  options: { host: HostEnvironment; stateDir: string; timeoutMs: number; signal?: AbortSignal },
): Promise<DaemonResponse> {
  const paths = resolveDaemonPaths(options.stateDir, {
    env: options.host.env,
    cwd: options.host.cwd,
  });
  const info = readRecordedDaemon(paths.infoPath);
  if (!info) throw new Error(`No daemon is running for state dir ${paths.baseDir}.`);
  return await sendDaemonRequest(
    info,
    { ...request, token: info.token },
    'auto',
    paths,
    options.timeoutMs,
    { host: options.host, signal: options.signal, timeoutRecovery: 'none' },
  );
}
