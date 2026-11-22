import {
  emitDiagnostic,
  flushDiagnosticsToSessionFile,
  getDiagnosticsMeta,
} from '@agent-device/host-kit/diagnostics';
import { normalizeError } from '@agent-device/kernel/errors';
import { exitAfterFlush } from './process-exit.ts';

const printHumanError = async (
  ...args: Parameters<typeof import('./failure-output.ts').printHumanError>
): Promise<void> => (await import('./failure-output.ts')).printHumanError(...args);

const printJson = (
  result:
    | { success: true; data?: unknown }
    | { success: false; error: ReturnType<typeof normalizeError> },
): Promise<void> =>
  import('../commands/output/json.ts').then(({ printJson: write }) => write(result));

/**
 * Prints one failure the CLI answers before it runs a command — a refused parse, or a provider
 * plugin refused before any option was resolved — and ends the process. The failure owns its
 * diagnostic phase, so each pre-command refusal stays distinguishable in the log.
 */
export async function exitBeforeCommand(
  error: unknown,
  argv: string[],
  options: { jsonRequested: boolean; debugEnabled: boolean },
  phase: string,
): Promise<never> {
  emitDiagnostic({
    level: 'error',
    phase,
    data: {
      error: error instanceof Error ? error.message : String(error),
    },
  });
  const normalized = normalizeError(error, {
    diagnosticId: getDiagnosticsMeta().diagnosticId,
    logPath: flushDiagnosticsToSessionFile({ force: true })?.path,
  });
  if (options.jsonRequested) {
    await printJson({ success: false, error: normalized });
  } else {
    await printHumanError(normalized, { debugTier: options.debugEnabled, argv });
  }
  return await exitAfterFlush(1);
}
