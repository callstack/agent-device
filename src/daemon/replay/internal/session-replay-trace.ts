import fs from 'node:fs';
import { redactDiagnosticData } from '@agent-device/kernel/redaction';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';

export function appendReplayTraceEvent(
  tracePath: string | undefined,
  event: Record<string, unknown>,
): void {
  if (!tracePath) return;
  try {
    fs.appendFileSync(tracePath, `${JSON.stringify(redactDiagnosticData(event))}\n`);
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
