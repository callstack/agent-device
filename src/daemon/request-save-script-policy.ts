import { AppError, normalizeError } from '@agent-device/kernel/errors';
import {
  emitDiagnostic,
  flushDiagnosticsToSessionFile,
  getDiagnosticsMeta,
} from '../utils/diagnostics.ts';
import { listSaveScriptFlagOwnerCommands, ownsSaveScriptFlag } from './daemon-command-registry.ts';
import type { DaemonRequest, DaemonResponse } from './types.ts';

/**
 * #1478: the released `--save-script` flag owners, read from the command
 * descriptor registry rather than re-stated here (AGENTS.md: never re-create
 * command string sets outside the declaration site).
 */
export const SAVE_SCRIPT_FLAG_OWNER_COMMANDS: readonly string[] = listSaveScriptFlagOwnerCommands();

const UNSUPPORTED_SAVE_SCRIPT_MESSAGE = `--save-script is supported only by ${SAVE_SCRIPT_FLAG_OWNER_COMMANDS.join(', ')}.`;

const UNSUPPORTED_SAVE_SCRIPT_HINT =
  'Arm publication on the session instead: open/close --save-script, replay --save-script, or session save-script to publish an armed recording without closing its session.';

/**
 * #1478 (P4-pre): `flags.saveScript` arms session-script publication the moment
 * a successful handler records the request's action (`recordActionEntry` sets
 * the authoring lifecycle and the target path), so ANY recordable command that reaches
 * a handler with the raw flag set can arm publication and later write a `.ad`
 * artifact — `record stop` writes one immediately through record-only cleanup,
 * `trace` and the interaction commands publish later on close.
 *
 * The CLI/Node/MCP surfaces only ever emit the flag for its released owners, so
 * the arming path is reachable only by a hand-built wire request. This closes
 * it at the daemon request seam — the single entry point BOTH the socket and
 * HTTP transports funnel through (`createRequestHandler`), and ahead of
 * admission, session lookup, device resolution, and handler dispatch — so an
 * unsupported request can neither arm publication nor perform any device work.
 *
 * Returns `undefined` when the request is allowed through: no flag at all
 * (including the flag absent from a request that never had it), or a released
 * owner command. Presence is what is rejected, not truthiness — a raw
 * `saveScript: false` is just as unsupported on `record` as `true` is, and
 * mirrors the maestro replay guard's `!== undefined` reading of the same flag.
 */
export function unsupportedSaveScriptFlagResponse(req: DaemonRequest): DaemonResponse | undefined {
  if (req.flags?.saveScript === undefined) return undefined;
  if (ownsSaveScriptFlag(req.command)) return undefined;

  emitDiagnostic({
    level: 'warn',
    phase: 'save_script_flag_rejected',
    data: { command: req.command },
  });
  // ADR 0010 decision 6: a failed request always carries its diagnosticId +
  // ndjson logPath, so this rejection is as traceable as a thrown one.
  const meta = getDiagnosticsMeta();
  const flushed = flushDiagnosticsToSessionFile({ force: true });
  return {
    ok: false,
    error: normalizeError(
      new AppError('INVALID_ARGS', UNSUPPORTED_SAVE_SCRIPT_MESSAGE, {
        hint: UNSUPPORTED_SAVE_SCRIPT_HINT,
      }),
      { diagnosticId: meta.diagnosticId, logPath: flushed?.path, diagnosticsRecord: flushed?.ref },
    ),
  };
}
