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

/**
 * #1258: point the session at `nextPath` and, when this is a RETARGET to a
 * different path than the one currently persisted AND no live
 * `--force`/`--overwrite` accompanies it, drop any `saveScriptForce` persisted
 * for the OLD target. Force is authorization for the target it was opted into
 * (`--save-script=a.ad --force`), NOT a session-wide standing grant that
 * silently follows a later `--save-script=b.ad` and overwrites a file nobody
 * opted to overwrite. A live `force` on this same retarget re-grants it for the
 * new target (handled by the caller, AFTER this — so a live flag always wins).
 * Shared by both re-arming paths: `armReplaySaveScriptStep` (replay) and
 * `recordActionEntry` (close --save-script).
 */
export function applySaveScriptRetarget(
  session: SessionState,
  nextPath: string,
  liveForce: boolean | undefined,
): void {
  const retargeted = session.saveScriptPath !== undefined && session.saveScriptPath !== nextPath;
  if (retargeted && !liveForce) session.saveScriptForce = undefined;
  session.saveScriptPath = nextPath;
}

export function recordActionEntry(
  session: SessionState,
  entry: RecordActionEntry,
): SessionAction | undefined {
  if (entry.flags?.noRecord) return undefined;
  if (entry.flags?.saveScript) {
    session.recordSession = true;
    if (typeof entry.flags.saveScript === 'string') {
      // ADR 0012 decision 6: an explicit `--save-script=<path>` (e.g. `close
      // --save-script=<path>`) clears the defaulted-healed marker, since this
      // path was no longer defaulted to the healed sibling. This marker plays
      // no role in the publish decision itself: the writer's refuse-on-exist
      // guard is uniform (see `publishHealedScriptAtomically`) and refuses
      // ANY pre-existing target — an explicit, caller-DIRECTED path included.
      // Directing the path is not the same as authorizing an overwrite.
      applySaveScriptRetarget(
        session,
        expandSessionPath(entry.flags.saveScript),
        entry.flags.force,
      );
      session.saveScriptDefaultedHealedPath = false;
    }
    // #1258: persist `--force`/`--overwrite`, like `saveScriptPath`, so a
    // LATER write that does not repeat the flag (a bare `close` finishing a
    // session opened with `open --save-script --force`, or an unattended
    // auto-commit teardown with no live request) still honors it. Sticky FOR
    // THE SAME TARGET — a retarget to a different path without a live `force`
    // drops it (see `applySaveScriptRetarget`); a same-path later action
    // carrying `saveScript` without `force` still must not clear it.
    if (entry.flags.force) {
      session.saveScriptForce = true;
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
  'force',
  'noRecord',
  'fps',
  'quality',
  'hideTouches',
  'count',
  'pointerCount',
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
