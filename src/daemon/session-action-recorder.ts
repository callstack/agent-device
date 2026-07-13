import type { CommandFlags } from '../core/dispatch.ts';
import { SCREENSHOT_ACTION_FLAG_KEYS } from '../contracts/screenshot.ts';
import { emitDiagnostic } from '../utils/diagnostics.ts';
import type { SessionAction, SessionRuntimeHints, SessionState } from './types.ts';
import { expandSessionPath } from './session-paths.ts';
import type { TargetAnnotationV1 } from '../replay/target-identity.ts';

export type RecordActionEntry = {
  command: string;
  positionals: string[];
  flags: CommandFlags;
  runtime?: SessionRuntimeHints;
  result?: Record<string, unknown>;
  targetEvidence?: TargetAnnotationV1;
};

export function recordActionEntry(
  session: SessionState,
  entry: RecordActionEntry,
): SessionAction | undefined {
  if (entry.flags?.noRecord) return undefined;
  if (entry.flags?.saveScript) {
    session.recordSession = true;
    if (typeof entry.flags.saveScript === 'string') {
      // ADR 0012 decision 6: an explicit `--save-script=<path>` (e.g. `close
      // --save-script=<path>`) clears the defaulted-healed marker so the
      // writer's clobber guard never refuses an overwrite the caller directed.
      session.saveScriptPath = expandSessionPath(entry.flags.saveScript);
      session.saveScriptDefaultedHealedPath = false;
    }
  }
  const action: SessionAction = {
    ts: Date.now(),
    command: entry.command,
    positionals: entry.positionals,
    runtime: entry.runtime,
    flags: sanitizeFlags(entry.flags),
    result: entry.result,
    ...(entry.targetEvidence ? { targetEvidence: entry.targetEvidence } : {}),
  };
  session.actions.push(action);
  emitDiagnostic({
    level: 'debug',
    phase: 'record_action',
    data: {
      command: entry.command,
      session: session.name,
    },
  });
  return action;
}

const SANITIZED_FLAG_KEYS = [
  'platform',
  'device',
  'udid',
  'serial',
  'out',
  'verbose',
  'metroHost',
  'metroPort',
  'bundleUrl',
  'launchUrl',
  'snapshotInteractiveOnly',
  'snapshotDepth',
  'snapshotScope',
  'snapshotRaw',
  ...SCREENSHOT_ACTION_FLAG_KEYS,
  'relaunch',
  'saveScript',
  'noRecord',
  'fps',
  'quality',
  'hideTouches',
  'count',
  'intervalMs',
  'delayMs',
  'holdMs',
  'jitterPx',
  'doubleTap',
  'clickButton',
  'pauseMs',
  'pattern',
] as const satisfies readonly (keyof CommandFlags)[];

function sanitizeFlags(flags: CommandFlags | undefined): SessionAction['flags'] {
  if (!flags) return {};
  const result: Record<string, unknown> = {};
  for (const key of SANITIZED_FLAG_KEYS) {
    if (flags[key] !== undefined) {
      result[key] = flags[key];
    }
  }
  return result as SessionAction['flags'];
}
