import type { CommandFlags } from '../../core/dispatch.ts';
import type { ReplayPlanDigestMetadata } from '../../replay/plan-digest.ts';
import type { ReplayScriptMetadata } from '../../replay/script.ts';
import type { DaemonResponse, SessionAction } from '../types.ts';
import { evaluateReplayResumePreflight } from './session-replay-resume.ts';
import { errorResponse } from './response.ts';

export function buildReplayMetadataFlags(
  flags: CommandFlags | undefined,
  metadata: ReplayScriptMetadata,
): CommandFlags {
  return {
    ...(flags ?? {}),
    ...(metadata.platform !== undefined && flags?.platform === undefined
      ? { platform: metadata.platform }
      : {}),
    ...(metadata.target !== undefined && flags?.target === undefined
      ? { target: metadata.target }
      : {}),
  };
}

/** The digest binds the same platform/target values the replay invokes with. */
export function readEffectiveReplayPlanDigestMetadata(
  flags: CommandFlags | undefined,
): ReplayPlanDigestMetadata {
  return {
    platform: typeof flags?.platform === 'string' ? flags.platform : undefined,
    target: typeof flags?.target === 'string' ? flags.target : undefined,
  };
}

type ReplayEntryIndexResult = { ok: true; value: number } | { ok: false; response: DaemonResponse };

/** The session-side state that gates an EMPTY-TAIL resume (`--from actionCount + 1`). */
export type PendingRecordAndHeal = { expectedFrom: number; actionsCountAtDivergence: number };

/**
 * Resolves `--from`/`--plan-digest` into a 0-based loop entry index before
 * any device action. `--from` is 1-based and matches divergence step indices.
 *
 * `pendingRecordAndHeal`/`sessionActionsLength` gate the ONE ordinal beyond
 * the plan's end (`actionCount + 1`): ADR 0012 decision 6, R2's `record-and-heal`
 * repair resumes past the plan's LAST step once the agent performs the
 * diverged step manually, and that resume must execute zero device actions
 * before reaching the normal completion path. That allowance is scoped to
 * the EXACT session + target that actually produced it (`stampPendingRecordAndHealWatermark`,
 * `session-replay-resume.ts`), and only once a new action proves the
 * corrective press happened — never a blanket "one past the end is fine" for
 * any session, which would let an unrelated or blind `--from actionCount + 1`
 * silently skip the plan's tail and commit an unfinished repair.
 */
export function resolveReplayEntryIndex(
  flags: CommandFlags | undefined,
  actionCount: number,
  planDigest: string,
  actions: SessionAction[],
  pendingRecordAndHeal: PendingRecordAndHeal | undefined,
  sessionActionsLength: number,
): ReplayEntryIndexResult {
  const from = flags?.replayFrom;
  const digest = flags?.replayPlanDigest;
  if (from === undefined && digest === undefined) return { ok: true, value: 0 };
  if (from === undefined || digest === undefined) {
    return invalidReplayEntryIndex(
      'replay --from requires --plan-digest (and --plan-digest requires --from).',
    );
  }
  const message = validateReplayResumeRequest({
    from,
    digest,
    planDigest,
    actionCount,
    actions,
    pendingRecordAndHeal,
    sessionActionsLength,
  });
  return message ? invalidReplayEntryIndex(message) : { ok: true, value: from - 1 };
}

function invalidReplayEntryIndex(message: string): ReplayEntryIndexResult {
  return { ok: false, response: errorResponse('INVALID_ARGS', message) };
}

/** A single sub-check of a `--from` resume request; `undefined` means "no objection". */
type ReplayResumeCheck = () => string | undefined;

function validateReplayResumeRequest(params: {
  from: number;
  digest: string;
  planDigest: string;
  actionCount: number;
  actions: SessionAction[];
  pendingRecordAndHeal: PendingRecordAndHeal | undefined;
  sessionActionsLength: number;
}): string | undefined {
  const {
    from,
    digest,
    planDigest,
    actionCount,
    actions,
    pendingRecordAndHeal,
    sessionActionsLength,
  } = params;
  const checks: ReplayResumeCheck[] = [
    () => describeOutOfRangeResumeFrom({ from, actionCount, pendingRecordAndHeal }),
    () => describeUnperformedRecordAndHeal({ from, pendingRecordAndHeal, sessionActionsLength }),
    () => describeStaleResumeDigest(digest, planDigest),
    () => describeUnsafeResumePreflight(from, actions),
  ];
  for (const check of checks) {
    const message = check();
    if (message) return message;
  }
  return undefined;
}

/**
 * `actionCount + 1` (one past the plan's end) is a legal EMPTY-TAIL resume
 * ONLY when it matches THIS session's own `record-and-heal` divergence
 * watermark (`stampPendingRecordAndHealWatermark`, `session-replay-resume.ts`)
 * — never a blanket "one past the end is fine" for any session or repair
 * kind. Absent a matching watermark, `actionCount + 1` is exactly as
 * out-of-range as any other ordinal beyond the plan.
 */
function describeOutOfRangeResumeFrom(params: {
  from: number;
  actionCount: number;
  pendingRecordAndHeal: PendingRecordAndHeal | undefined;
}): string | undefined {
  const { from, actionCount, pendingRecordAndHeal } = params;
  const isAuthorizedEmptyTail =
    from === actionCount + 1 &&
    pendingRecordAndHeal !== undefined &&
    pendingRecordAndHeal.expectedFrom === from;
  const inRange =
    Number.isInteger(from) && from >= 1 && (from <= actionCount || isAuthorizedEmptyTail);
  return inRange
    ? undefined
    : `replay --from ${from} is out of range for a ${actionCount}-step plan.`;
}

/**
 * A `from` matching a pending `record-and-heal` watermark — in-range
 * (mid-plan) or the empty-tail boundary the range check above authorizes —
 * requires proof the agent actually performed the diverged step: the
 * session's recorded action count must have grown since the divergence.
 * Without that proof, this would silently resume past an unrepaired step
 * instead of rejecting.
 */
function describeUnperformedRecordAndHeal(params: {
  from: number;
  pendingRecordAndHeal: PendingRecordAndHeal | undefined;
  sessionActionsLength: number;
}): string | undefined {
  const { from, pendingRecordAndHeal, sessionActionsLength } = params;
  if (
    pendingRecordAndHeal?.expectedFrom !== from ||
    sessionActionsLength !== pendingRecordAndHeal.actionsCountAtDivergence
  ) {
    return undefined;
  }
  return (
    `replay --from ${from} continues a record-and-heal repair, but no corrective action has been ` +
    'recorded on this session since that divergence; press the correct control via a blessed @ref ' +
    "from the divergence's screen.refs (recorded, no --no-record) before resuming with " +
    `--from ${from}.`
  );
}

function describeStaleResumeDigest(digest: string, planDigest: string): string | undefined {
  if (digest === planDigest) return undefined;
  return (
    'replay --plan-digest does not match the current plan digest; the script, its includes, or its ' +
    'platform-conditioned expansion changed since the divergence report was generated. Run a fresh full ' +
    'replay to get a new digest.'
  );
}

function describeUnsafeResumePreflight(from: number, actions: SessionAction[]): string | undefined {
  const preflight = evaluateReplayResumePreflight({ from, actions });
  return preflight.allowed ? undefined : `replay --from ${from} cannot resume: ${preflight.reason}`;
}
