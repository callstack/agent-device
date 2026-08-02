/**
 * #1555 review P1 ("parsing/planning/digest/resume must also occur behind
 * runAdReplay"): the `--from`/`--plan-digest` resume-point math, relocated
 * verbatim from the daemon's `session-replay-runtime-plan.ts`
 * (`resolveReplayEntryIndex`) into the engine. This is pure over plain
 * values — it never touches `SessionStore`, the P4b repair coordinator, or a
 * `DaemonResponse` — so the only thing that changes by moving it here is
 * OWNERSHIP, not behavior or call timing: `inspectAdReplay`'s manifest
 * exposes it as `resolveEntryIndex`, and the daemon calls it at exactly the
 * point `resolveReplayEntryIndex` used to run (`prepareReplayPlan`, BEFORE
 * `prepareReplaySession`'s coordinator-mutating side effects). That ordering
 * is load-bearing: an invalid `--from` must be rejected before anything
 * about the session or its repair transaction is touched, so this cannot
 * move to run any later (e.g. inside `runAdReplay`'s own step loop) without
 * either reordering `prepareReplaySession` around it or letting a rejected
 * resume request mutate coordinator state first — see the #1555 R2 handoff
 * notes for why that reordering was judged out of scope here.
 */

/**
 * The session-side state that gates an EMPTY-TAIL resume (`--from actionCount
 * + 1`). Stamped for `record-and-heal`, and per #1262 also for
 * `caution`/`manual`'s record-and-heal-shaped alternate repair (their own
 * unshifted `resume.from` is unaffected by this watermark).
 */
export type PendingRecordAndHeal = Readonly<{
  expectedFrom: number;
  actionsCountAtDivergence: number;
}>;

export type AdReplayEntryIndexParams = Readonly<{
  from: number | undefined;
  digest: string | undefined;
  pendingRecordAndHeal: PendingRecordAndHeal | undefined;
  sessionActionsLength: number;
}>;

export type AdReplayEntryIndexResult =
  | Readonly<{ readonly ok: true; readonly value: number }>
  | Readonly<{ readonly ok: false; readonly message: string }>;

/**
 * Resolves `--from`/`--plan-digest` into a 0-based loop entry index before
 * any device action. `--from` is 1-based and matches divergence step indices.
 *
 * `pendingRecordAndHeal`/`sessionActionsLength` gate the ONE ordinal beyond
 * the plan's end (`actionCount + 1`): ADR 0012 decision 6, R2's `record-and-heal`
 * repair — and, per #1262, `caution`/`manual`'s record-and-heal-SHAPED
 * alternate repair — resumes past the plan's LAST step once the agent
 * performs the diverged step's intent as a recorded action, and that resume
 * must execute zero device actions before reaching the normal completion
 * path. That allowance is scoped to the EXACT session + target that actually
 * produced it (the daemon's `ReplayCoordinator`'s `stampCorrectiveWatermark`),
 * and only once a new action proves the corrective press happened — never a
 * blanket "one past the end is fine" for any session, which would let an
 * unrelated or blind `--from actionCount + 1` silently skip the plan's tail
 * and commit an unfinished repair. `caution`/`manual`'s OWN `resume.from`
 * (the failed step's own index, unshifted) stays legal unconditionally
 * regardless of this watermark — it is always `<= actionCount`, never the
 * one-past-the-end ordinal this gate concerns.
 */
export function resolveReplayEntryIndex(
  params: AdReplayEntryIndexParams,
  actionCount: number,
  planDigest: string,
): AdReplayEntryIndexResult {
  const { from, digest, pendingRecordAndHeal, sessionActionsLength } = params;
  if (from === undefined && digest === undefined) return { ok: true, value: 0 };
  if (from === undefined || digest === undefined) {
    return {
      ok: false,
      message: 'replay --from requires --plan-digest (and --plan-digest requires --from).',
    };
  }
  const message = validateReplayResumeRequest({
    from,
    digest,
    planDigest,
    actionCount,
    pendingRecordAndHeal,
    sessionActionsLength,
  });
  return message ? { ok: false, message } : { ok: true, value: from - 1 };
}

/** A single sub-check of a `--from` resume request; `undefined` means "no objection". */
type ReplayResumeCheck = () => string | undefined;

function validateReplayResumeRequest(params: {
  from: number;
  digest: string;
  planDigest: string;
  actionCount: number;
  pendingRecordAndHeal: PendingRecordAndHeal | undefined;
  sessionActionsLength: number;
}): string | undefined {
  const { from, digest, planDigest, actionCount, pendingRecordAndHeal, sessionActionsLength } =
    params;
  const checks: ReplayResumeCheck[] = [
    () => describeOutOfRangeResumeFrom({ from, actionCount, pendingRecordAndHeal }),
    () => describeUnperformedRecordAndHeal({ from, pendingRecordAndHeal, sessionActionsLength }),
    () => describeStaleResumeDigest(digest, planDigest),
  ];
  for (const check of checks) {
    const message = check();
    if (message) return message;
  }
  return undefined;
}

/**
 * `actionCount + 1` (one past the plan's end) is a legal EMPTY-TAIL resume
 * ONLY when it matches THIS session's own record-and-heal-shaped divergence
 * watermark — never a blanket "one past the end is fine" for any session or
 * repair kind. Absent a matching watermark, `actionCount + 1` is exactly as
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
 * A `from` matching a pending record-and-heal-shaped watermark — in-range
 * (mid-plan, `record-and-heal` only) or the empty-tail boundary the range
 * check above authorizes (`record-and-heal`, or per #1262 also
 * `caution`/`manual`'s alternate repair, which is ONLY ever stamped at that
 * boundary) — requires proof the agent actually performed the diverged step:
 * the session's recorded action count must have grown since the divergence.
 * Without that proof, this would silently resume past an unrepaired step
 * instead of rejecting. `caution`/`manual`'s own `resume.from` stays at the
 * failed step unchanged and is never subject to this check (it never
 * matches `expectedFrom`, which only ever targets `failedIndex + 1`), so the
 * message below is intentionally hint-neutral.
 *
 * #1271 stage 2 (ADR 0012 amendment): this same growth check is now also the
 * repair-segment empty-heal guard. Observation-only actions
 * (`snapshot`/`get`/`is`/`find`) are, by default, excluded from
 * `session.actions` while repair-armed, so a repair segment containing ONLY
 * unrecorded diagnostic reads never grows `sessionActionsLength` either —
 * this check refuses it exactly as it already refused "no corrective press
 * happened," converting the corrective-read case's one silent-failure mode
 * (an excluded read silently missing from the heal) into this same loud
 * rejection. The message therefore names `--record` alongside the existing
 * `--no-record` mention, since the missing corrective action may have been a
 * read rather than a press.
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
    `replay --from ${from} continues a record-and-heal-shaped repair, but no corrective action was ` +
    "recorded in this repair segment; press the correct control via a blessed @ref from the divergence's " +
    'screen.refs (recorded, no --no-record) — or, if your corrective action was a read ' +
    '(get/is/find/snapshot), re-run it with --record so it lands in the heal — before resuming with ' +
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
