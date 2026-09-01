import type { SessionAction } from '@agent-device/contracts/session';
import type { CommandFlags } from '@agent-device/contracts/command';
import { SCREENSHOT_ACTION_FLAG_KEYS } from '@agent-device/contracts/capture';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import type { DaemonRequest, SessionRuntimeHints, SessionState } from './types.ts';
import { applyRecordedSaveScriptFlags } from './session-script-publication-capability.ts';
import { repairSessionBoundary } from './session-replay-transaction.ts';
import type { MultiTargetAnnotationV1, TargetAnnotationV1 } from '@agent-device/contracts/replay';
import { inferFillText } from './action-utils.ts';
import {
  recordedInputPlaceholder,
  validateRecordedInputVariableName,
} from '@agent-device/ad-script';
import {
  parameterizeRecordedFillPayload,
  parameterizeRecordedFillTargetEvidence,
  parameterizeRecordedResultEcho,
  parameterizeTargetEvidenceEcho,
  targetEvidenceCarriesAnyLiteral,
} from './parameterized-recorded-fill.ts';
import type { TargetEvidenceMode } from './session-target-evidence.ts';

export type RecordActionEntry = {
  command: string;
  positionals: string[];
  flags: CommandFlags;
  runtime?: SessionRuntimeHints;
  result?: Record<string, unknown>;
  targetEvidence?: TargetAnnotationV1;
  targetEvidences?: MultiTargetAnnotationV1;
  /**
   * #1398: which `computeTargetEvidence` mode produced `targetEvidence`, so
   * session-scoped echo protection (below) can apply the SAME
   * landmark-vs-action treatment #1349 already established for identity-empty
   * evidence. Defaults to `action` when absent — every call site other than
   * `wait`'s landmark recording computes action-mode evidence and never needs
   * to set this explicitly.
   */
  targetEvidenceMode?: TargetEvidenceMode;
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
  const fillLiteral = readRecordedFillLiteral(entry);
  // #1398: register the literal only AFTER protecting this SAME entry, so a
  // fill's own recording is never passed through the session-wide substring
  // scan against the value it JUST introduced — that pass is coarser
  // (content-aware substring, not the fill boundary's exact-field match) and
  // would otherwise mangle unrelated short incidental substrings (e.g. a
  // one-character `--record-as` value colliding with ordinary words) in the
  // very entry that introduced it. The session-wide guarantee is for LATER,
  // distinct actions, exactly as #1398 frames it; this entry keeps only the
  // existing fill-step-scoped exact-match protection below.
  const recordedEntry = applySessionEchoProtection(
    session,
    parameterizeRecordedFill(entry, fillLiteral),
  );
  if (fillLiteral) registerRecordedFillLiteral(session, fillLiteral);
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

type SessionActionStore = { recordAction(session: SessionState, entry: RecordActionEntry): void };

/**
 * Record a session action if a session is active. No-op when session is undefined.
 *
 * By default the recorded positionals/flags mirror the request; pass `overrides` to
 * record a different set (e.g. resolved positionals or stripped public flags).
 */
export function recordSessionAction(
  sessionStore: SessionActionStore,
  session: SessionState | undefined,
  req: DaemonRequest,
  command: string,
  result: Record<string, unknown> | undefined,
  overrides?: { positionals?: string[]; flags?: CommandFlags },
): void {
  if (!session) return;
  sessionStore.recordAction(session, {
    command,
    positionals: overrides?.positionals ?? req.positionals ?? [],
    flags: overrides?.flags ?? ((req.flags ?? {}) as CommandFlags),
    result: result ?? {},
  });
}

type FillLiteral = { literal: string; placeholder: string };

/** The (literal, placeholder) pair a `fill --record-as` entry carries, or `undefined` for an ordinary fill/other command. */
function readRecordedFillLiteral(entry: RecordActionEntry): FillLiteral | undefined {
  if (entry.command !== 'fill' || typeof entry.flags.recordAs !== 'string') return undefined;
  const variableName = validateRecordedInputVariableName(entry.flags.recordAs);
  const placeholder = recordedInputPlaceholder(variableName);
  const literal = inferFillText({
    ts: 0,
    command: entry.command,
    positionals: entry.positionals,
    flags: entry.flags,
  });
  return { literal, placeholder };
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
function parameterizeRecordedFill(
  entry: RecordActionEntry,
  fillLiteral: FillLiteral | undefined,
): RecordActionEntry {
  if (!fillLiteral) return entry;
  const { literal, placeholder } = fillLiteral;
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

/**
 * #1398 (ADR 0017 session-scoped echo protection amendment): remember an
 * explicitly parameterized literal for the REST of this recording session, so
 * a later, unrelated action's own recorded evidence can be checked against
 * it. A whitespace-only or empty resolved value is deliberately excluded —
 * it keeps only the fill-step-scoped protection `parameterizeRecordedFill`
 * already gives it above. Collapsing arbitrary later strings on a value with
 * no discriminating content would be a disproportionate readability cost for
 * a value that reveals nothing distinctive if echoed, and an empty literal
 * would match every string.
 *
 * The map is keyed by literal, so two DIFFERENT `--record-as` names that
 * happen to share the same typed value (a password/confirm-password pair,
 * say) are genuinely indistinguishable from a later echo's perspective — the
 * literal alone cannot say which fill produced it. The first-registered name
 * wins deterministically rather than a later, unrelated fill silently
 * re-attributing an earlier echo to its own name; the literal itself is
 * redacted either way, so this only affects WHICH placeholder name is used,
 * never whether the value is protected.
 */
function registerRecordedFillLiteral(session: SessionState, fillLiteral: FillLiteral): void {
  if (!fillLiteral.literal.trim()) return;
  session.recordedFillLiterals ??= new Map();
  if (session.recordedFillLiterals.has(fillLiteral.literal)) return;
  session.recordedFillLiterals.set(fillLiteral.literal, fillLiteral.placeholder);
}

/**
 * #1398: apply every literal registered so far in THIS session to the
 * CURRENT entry, whatever command produced it. A no-op fast path keeps
 * ordinary, non-parameterized recordings byte-for-byte unchanged.
 * `parameterizeRecordedResultEcho`/`parameterizeTargetEvidenceEcho` redact
 * every registered literal in one placeholder-safe pass each (see
 * `parameterizeAgainstLiteralMap`), so no per-literal sequencing is needed
 * here.
 */
function applySessionEchoProtection(
  session: SessionState,
  entry: RecordActionEntry,
): RecordActionEntry {
  const literals = session.recordedFillLiterals;
  if (!literals || literals.size === 0) return entry;

  const result = parameterizeRecordedResultEcho(entry.result, literals);
  const evidenceMode = entry.targetEvidenceMode ?? 'action';
  const targetEvidence =
    evidenceMode === 'landmark'
      ? redactLandmarkEvidenceEcho(entry.targetEvidence, literals)
      : redactActionModeEvidenceEcho(entry.targetEvidence, literals);
  const targetEvidences = entry.targetEvidences
    ? {
        source: redactActionModeEvidenceEcho(entry.targetEvidences.source, literals),
        destination: redactActionModeEvidenceEcho(entry.targetEvidences.destination, literals),
      }
    : entry.targetEvidences;

  return { ...entry, result, targetEvidence, targetEvidences };
}

/**
 * #1398: a landmark-mode echo is treated exactly like #1349's existing
 * identity-empty case — record NO annotation rather than a placeholder that
 * could never replay-match (the app re-echoes the REAL value at replay time,
 * so a recorded `${VAR}` label can only ever mismatch it). A `wait` used as
 * an ADR 0016 destination guard requires `verification: "verified"`, so a
 * landmark whose only identity is a parameterized-value echo simply stops
 * qualifying as a guard — publication refuses it and directs the author to a
 * different, non-value-bearing landmark, same as the motivating scenario.
 */
function redactLandmarkEvidenceEcho(
  evidence: TargetAnnotationV1 | undefined,
  literals: ReadonlyMap<string, string>,
): TargetAnnotationV1 | undefined {
  if (!evidence) return evidence;
  return targetEvidenceCarriesAnyLiteral(evidence, literals) ? undefined : evidence;
}

/**
 * #1398: action-mode evidence (`get`, `is`, and mutating element-targeting
 * actions) is required by ADR 0012/0016 and must never be silently dropped.
 * Every echoed literal-bearing label is redacted to its placeholder in one
 * placeholder-safe pass (a label can legitimately echo more than one
 * already-parameterized value, e.g. "Signed in as bob, session
 * hunter2-secret" after separate USERNAME and PASSWORD fills) AND
 * `verification` is downgraded to `"unverifiable"` — the SAME fail-closed
 * downgrade decision 3's writer-parser invariant already uses for an
 * oversized payload. That fails the action's replay loudly
 * (`identity-unverifiable`) instead of silently weakening it to
 * selector-only matching or falsely claiming `verified` against a label that
 * can never match again.
 */
function redactActionModeEvidenceEcho(
  evidence: TargetAnnotationV1,
  literals: ReadonlyMap<string, string>,
): TargetAnnotationV1;
function redactActionModeEvidenceEcho(
  evidence: TargetAnnotationV1 | undefined,
  literals: ReadonlyMap<string, string>,
): TargetAnnotationV1 | undefined;
function redactActionModeEvidenceEcho(
  evidence: TargetAnnotationV1 | undefined,
  literals: ReadonlyMap<string, string>,
): TargetAnnotationV1 | undefined {
  if (!evidence) return evidence;
  if (!targetEvidenceCarriesAnyLiteral(evidence, literals)) return evidence;
  return { ...parameterizeTargetEvidenceEcho(evidence, literals), verification: 'unverifiable' };
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
 * `session-action-recorder.ts`), so `find` here always means a read-only
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
 *     `invokeResolvedReplayAction`, `daemon/replay/internal/session-replay-action-runtime.ts`).
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
 * rather than on whether the session records at all, is exactly what keeps
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
  'snapshotCustomActions',
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
