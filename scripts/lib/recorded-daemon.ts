import { readDaemonRecord } from '@agent-device/daemon-contracts/daemon-resolution';

/**
 * The registration a state directory records, as the measurement and live-lane tooling reads it.
 * Sending to that daemon goes through `sendToRecordedDaemon` in `@agent-device/daemon-client`.
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
