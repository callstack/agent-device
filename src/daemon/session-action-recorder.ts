import type { SessionAction } from '@agent-device/contracts/session';
import type { CommandFlags } from '@agent-device/contracts/command';
import { SCREENSHOT_ACTION_FLAG_KEYS } from '@agent-device/contracts/capture';
import { emitDiagnostic } from '../utils/diagnostics.ts';
import type { DaemonRequest, SessionRuntimeHints, SessionState } from './types.ts';
import { applyRecordedSaveScriptFlags } from './session-script-publication-capability.ts';
import { repairSessionBoundary } from './session-replay-transaction.ts';
import type { MultiTargetAnnotationV1, TargetAnnotationV1 } from '@agent-device/contracts/replay';
import { inferFillText } from './action-utils.ts';
import {
  recordedInputPlaceholder,
  validateRecordedInputVariableName,
} from '../replay/recorded-input.ts';
import {
  parameterizeRecordedFillPayload,
  parameterizeRecordedFillTargetEvidence,
} from './parameterized-recorded-fill.ts';

export type RecordActionEntry = {
  command: string;
  positionals: string[];
  flags: CommandFlags;
  runtime?: SessionRuntimeHints;
  result?: Record<string, unknown>;
  targetEvidence?: TargetAnnotationV1;
  targetEvidences?: MultiTargetAnnotationV1;
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

export function recordActionEntry(
  session: SessionState,
  entry: RecordActionEntry,
): SessionAction | undefined {
  if (entry.flags?.noRecord) return undefined;
  if (isExcludedRepairSegmentObservation(session, entry)) return undefined;
  if (entry.flags) applyRecordedSaveScriptFlags(session, entry.flags);
  const recordedEntry = parameterizeRecordedFill(entry);
  const action: SessionAction = {
    ts: Date.now(),
    command: recordedEntry.command,
    positionals: recordedEntry.positionals,
    runtime: recordedEntry.runtime,
    flags: sanitizeFlags(recordedEntry.flags),
    result: recordedEntry.result,
    ...(recordedEntry.targetEvidence ? { targetEvidence: recordedEntry.targetEvidence } : {}),
    ...(recordedEntry.targetEvidences ? { targetEvidences: recordedEntry.targetEvidences } : {}),
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
 * #1348: the recorder is the first durable boundary. The live request keeps
 * the literal fill value through device execution, but the SessionAction gets
 * only `${VAR}`. The result's semantic fill-value field is parameterized at
 * the same boundary, while selector/ref provenance is preserved byte-for-byte.
 * Exact value-bearing selector candidates are omitted, and exact accessibility
 * value labels in ADR 0012 evidence are parameterized without rewriting
 * unrelated identity fragments.
 */
function parameterizeRecordedFill(entry: RecordActionEntry): RecordActionEntry {
  if (entry.command !== 'fill' || typeof entry.flags.recordAs !== 'string') return entry;
  const variableName = validateRecordedInputVariableName(entry.flags.recordAs);
  const placeholder = recordedInputPlaceholder(variableName);
  const literal = inferFillText({
    ts: 0,
    command: entry.command,
    positionals: entry.positionals,
    flags: entry.flags,
  });
  return {
    ...entry,
    positionals: replaceFillText(entry.positionals, placeholder),
    result: parameterizeRecordedFillPayload(entry.result, literal, placeholder),
    targetEvidence: parameterizeRecordedFillTargetEvidence(
      entry.targetEvidence,
      literal,
      placeholder,
    ),
  };
}

function replaceFillText(positionals: string[], placeholder: string): string[] {
  const first = positionals[0];
  if (first?.startsWith('@')) {
    return positionals.length >= 3 ? [first, positionals[1]!, placeholder] : [first, placeholder];
  }
  if (
    positionals.length >= 3 &&
    Number.isFinite(Number(positionals[0])) &&
    Number.isFinite(Number(positionals[1]))
  ) {
    return [positionals[0]!, positionals[1]!, placeholder];
  }
  return first === undefined ? [placeholder] : [first, placeholder];
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
 * (`buildOptimizedActions` over `session.actions` from the repair boundary).
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
 * A repair boundary is set ONLY by a repair-armed
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
  if (repairSessionBoundary(session) === undefined) return false;
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
