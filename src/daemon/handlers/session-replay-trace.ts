import fs from 'node:fs';
import { redactDiagnosticData } from '../../kernel/redaction.ts';
import { emitDiagnostic } from '../../utils/diagnostics.ts';

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
