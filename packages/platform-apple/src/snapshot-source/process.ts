import { Buffer } from 'node:buffer';
import type { ExecResult } from '@agent-device/host-kit/command';
import { snapshotSourceError, type SnapshotSourceError } from './errors.ts';
import type { SnapshotSourceHost, SnapshotSourceProcess } from './types.ts';

const MAX_PROCESS_LOG_BYTES = 64 * 1024;
const diagnosedProcesses = new WeakSet<SnapshotSourceProcess>();

export async function bridgeProcessExited(
  host: SnapshotSourceHost,
  bridgeProcess: SnapshotSourceProcess,
): Promise<SnapshotSourceError> {
  let exitCode: ExecResult['exitCode'] | undefined;
  try {
    exitCode = (await bridgeProcess.wait).exitCode;
  } catch {
    exitCode = undefined;
  }
  if (!diagnosedProcesses.has(bridgeProcess)) {
    diagnosedProcesses.add(bridgeProcess);
    host.emitDiagnostic({
      level: 'error',
      phase: 'ios.snapshot-source.bridge-process-exit',
      data: {
        pid: bridgeProcess.pid,
        ...(exitCode === undefined ? {} : { exitCode }),
        stderr: boundedProcessLog(bridgeProcess.readLog()),
      },
    });
  }
  return snapshotSourceError('process-crash', 'bridge-exited', {
    pid: bridgeProcess.pid,
    ...(exitCode === undefined ? {} : { exitCode }),
  });
}

function boundedProcessLog(log: string): string {
  const bytes = Buffer.from(log);
  if (bytes.length <= MAX_PROCESS_LOG_BYTES) return log;
  return bytes.subarray(-MAX_PROCESS_LOG_BYTES).toString('utf8');
}
