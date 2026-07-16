import type { CommandFlags } from '../core/dispatch.ts';
import { SCREENSHOT_ACTION_FLAG_KEYS } from '../contracts/screenshot.ts';
import { emitDiagnostic } from '../utils/diagnostics.ts';
import type { DaemonRequest, SessionAction, SessionRuntimeHints, SessionState } from './types.ts';
import { expandSessionPath } from './session-paths.ts';
import type { TargetAnnotationV1 } from '../replay/target-identity.ts';

export type RecordActionEntry = {
  command: string;
  positionals: string[];
  flags: CommandFlags;
  runtime?: SessionRuntimeHints;
  result?: Record<string, unknown>;
  targetEvidence?: TargetAnnotationV1;
  /**
   * #1271 stage 2 (ADR 0012 amendment): an observation-only command
   * (`snapshot`/`get`/`is`/read-only `find`) dispatched OUT OF BAND — typed by
   * the agent mid-repair rather than replayed from the `.ad` plan under
   * repair. Computed by `isInteractiveObservation` below; only actions with
   * this flag are subject to the repair-segment default exclusion.
   *
   * The qualifier is load-bearing: command class ALONE is the wrong
   * discriminator. An authored `get`/`is`/`find` plan step is the same command
   * as an interactive diagnostic read, but it must survive into its own healed
   * script — dropping it would make the heal quietly stop asserting what the
   * original flow asserted. Provenance separates them.
   */
  interactiveObservation?: boolean;
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
  if (isExcludedRepairSegmentObservation(session, entry)) return undefined;
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

/**
 * #1271 stage 2 (ADR 0012 amendment): observation-only commands — the ONLY
 * commands the repair-segment exclusion can drop. `wait` is deliberately
 * absent: it is flow timing/synchronisation, not observation, so it always
 * records. A mutating `find … click|fill|focus|type` never reaches a caller of
 * `isInteractiveObservation` (it records through `recordSessionAction`,
 * `handlers/handler-utils.ts`), so `find` here always means a read-only
 * sub-action; `diff` is likewise absent because only `snapshot` is classified
 * at the snapshot-runtime call site.
 */
const OBSERVATION_ONLY_COMMANDS: ReadonlySet<string> = new Set(['snapshot', 'get', 'is', 'find']);

/**
 * #1271 stage 2 (ADR 0012 amendment): is this request an out-of-band
 * interactive observation — the only thing a repair segment excludes?
 *
 * Two facts, ANDed, and the second is the one that matters:
 *  1. the command is observation-only (above); and
 *  2. it is NOT a replay plan step (`internal.replayPlanStep`, stamped by
 *     `invokeResolvedReplayAction`, `handlers/session-replay-action-runtime.ts`).
 *
 * (2) is why this is a PROVENANCE rule, not a command-class rule. Replayed
 * plan steps dispatch through the ordinary request path and land in
 * `session.actions` like any other action; the healed script is that slice
 * (`buildOptimizedActions` over `session.actions.slice(saveScriptBoundary)`).
 * So excluding by command class alone would replay an authored `is visible`
 * assertion and then silently drop it from its own heal — the healed flow
 * would quietly stop checking what it used to check. Authored observations
 * must survive automatically; users must never have to annotate their own
 * `.ad` steps with `--record`.
 */
export function isInteractiveObservation(req: DaemonRequest): boolean {
  if (req.internal?.replayPlanStep === true) return false;
  return OBSERVATION_ONLY_COMMANDS.has(req.command);
}

/**
 * #1271 stage 2 (ADR 0012 amendment): the repair-segment default exclusion.
 *
 * `session.saveScriptBoundary !== undefined` is set ONLY by a repair-armed
 * `replay --save-script` (decision 6, R1/R6) — an ordinary, non-repair
 * `open --save-script`/`close --save-script` authoring recording never sets
 * it (see the ADR's "Scope" note under decision 6). Gating on this field,
 * rather than on `session.recordSession` alone, is exactly what keeps
 * ordinary authoring recording completely unchanged: a fresh `open
 * --save-script` session records every action, including reads, precisely as
 * it always has.
 *
 * Inside a repair-armed session, an out-of-band interactive observation is
 * excluded from `session.actions` unless the caller passed `--record`.
 * Because the exclusion happens HERE — at the same point `--no-record` is
 * enforced — an excluded action never grows `session.actions.length`, which is
 * the exact counter `describeUnperformedRecordAndHeal`
 * (`session-replay-runtime-plan.ts`) already watches to prove a corrective
 * action was recorded since the divergence. That existing fail-loud guard
 * therefore correctly refuses a `--from` resume whose only "activity" since
 * the divergence was excluded diagnostic reads, with no separate bookkeeping
 * needed here.
 */
function isExcludedRepairSegmentObservation(
  session: SessionState,
  entry: RecordActionEntry,
): boolean {
  if (!entry.interactiveObservation) return false;
  if (session.saveScriptBoundary === undefined) return false;
  return entry.flags?.record !== true;
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
  'record',
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
