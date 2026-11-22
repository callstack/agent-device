import fs from 'node:fs';
import { redactDiagnosticData } from '@agent-device/kernel/redaction';
import { captureDiagnosticTraceWriter, emitDiagnostic } from '@agent-device/host-kit/diagnostics';

export function appendReplayTraceEvent(
  tracePath: string | undefined,
  event: Record<string, unknown>,
): void {
  const scopedWrite = tracePath ? undefined : captureDiagnosticTraceWriter();
  if (!tracePath && !scopedWrite) return;
  try {
    const line = `${JSON.stringify(redactDiagnosticData(event))}\n`;
    if (tracePath) fs.appendFileSync(tracePath, line);
    else scopedWrite?.(line);
  } catch (error) {
    emitDiagnostic({
      level: 'warn',
      phase: 'replay_trace_write_failed',
      data: {
        path: tracePath,
        error: error instanceof Error ? error.message : String(error),
      },
    });
  }
}
