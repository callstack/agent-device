import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import type { PostGestureAction, PostGestureOutcome } from '@agent-device/kernel/snapshot';
import { observeUntil, type ObservationClock, type ObservationSchedule } from './observe-until.ts';

/**
 * Pure post-gesture stability mechanics: the quiet-window verdict over the shared
 * `observeUntil` engine, plus the baseline-distrust decision, parameterized over
 * the capture value and the signature comparators. Deliberately a leaf — it
 * imports no cycle owners and no `SessionState`, so it stays outside the R9
 * type cycle while the deferred-interaction-outcome owner (which holds the
 * pending record and the session mutation) stays the one seam callers see. The
 * owner supplies the comparators from interaction-surface-signature; their
 * semantics (subset tolerance, identity keying, discriminating entries) are
 * documented there.
 */

/**
 * Cadence and budget for the quiet-window loop: poll every 200ms, allow 1.5s
 * before an unsettled surface times out, and always complete two observations
 * (an `initial` counts) so a quiet pair can form even under a tight budget.
 */
const POST_GESTURE_STABILITY_SCHEDULE: ObservationSchedule = {
  intervalMs: 200,
  budgetMs: 1_500,
  minPolls: 2,
};

/**
 * Defect 2 (#1542): a bounded extra budget used ONLY when a quiet signature
 * match (two consecutive polls agree) still equals the pre-gesture baseline on
 * the Apple synthesized-gesture lane. XCTest's AX tree isn't proactively
 * resynced by a synthesized touch, so it can serve a stale-but-internally-
 * consistent read that two polls agree on without the screen having moved.
 *
 * 2s of real margin over both the poll interval (200ms) and the normal
 * deadline (1.5s) — a near-zero margin between a poll interval and a quiet
 * window is a proven flake source in this codebase (see
 * settle-zero-margin-flake, a week-long contention-flake root cause), so this
 * cap is sized to never come close to that trap.
 */
const STABILIZATION_DISTRUST_DEADLINE_MS = POST_GESTURE_STABILITY_SCHEDULE.budgetMs + 2_000;

export type BaselineSurfaceEvidence = 'changed' | 'unchanged' | 'ambiguous';

/**
 * One surface reading that can stand as a comparison baseline. Signature and key travel together:
 * captures from different surfaces are not views of one screen (#1569, #2438). `comparisonKey` is
 * undefined for legacy observations that carry no key. A quiet pair with two absent keys does not
 * rebase: absent keys never prove a surface change, and never prove sameness either.
 */
export type PostGestureSurfaceReading<S> = Readonly<{
  signature: S;
  comparisonKey: string | undefined;
}>;

/**
 * What the loop compares a quiet pair against, tagged by provenance. Only `pre-action` — read
 * before the gesture dispatched — can show a stale read or prove no effect; a `post-action`
 * baseline was adopted mid-loop after the gesture, and matching it is what a surface at rest does
 * (#3868).
 */
export type PostGestureBaseline<S> =
  | (PostGestureSurfaceReading<S> & Readonly<{ provenance: 'pre-action' }>)
  | (PostGestureSurfaceReading<S> & Readonly<{ provenance: 'post-action' }>);

export type PostGesturePreActionBaseline<S> = Extract<
  PostGestureBaseline<S>,
  Readonly<{ provenance: 'pre-action' }>
>;

/**
 * The quiet-pair verdict. `accept-stale` carries the pre-action reading that authorized it as its
 * payload, so the no-effect proof consumes exactly that evidence; a post-action baseline has no
 * route to this verdict.
 */
export type PostGestureStabilityDecision<S extends readonly unknown[]> =
  | Readonly<{ verdict: 'trust' }>
  | Readonly<{ verdict: 'distrust' }>
  | Readonly<{ verdict: 'accept-stale'; preActionBaseline: PostGesturePreActionBaseline<S> }>;

export type PostGestureStabilityPending<S> = {
  action: string;
  positionals: string[];
  /** Absent when the writer stored no baseline (non-Apple, or nothing usable pre-gesture). */
  baseline?: PostGesturePreActionBaseline<S>;
};

export type PostGestureStabilityHooks<T, S extends readonly unknown[]> = {
  capture: () => Promise<T>;
  /** One attempt's signature plus the surface that served it, for quiet-window comparison. */
  readSurface: (value: T) => PostGestureSurfaceReading<S>;
  /** Two consecutive polls agree — the quiet-window test. */
  signaturesStable: (previous: S, current: S) => boolean;
  /** Subset-tolerant baseline comparison feeding the distrust verdict. */
  classifyBaselineEvidence: (baseline: S, quiet: S) => BaselineSurfaceEvidence;
  /** Full-surface both-direction agreement — the no-effect corroboration bar. */
  surfacesIdentical: (baseline: S, current: S) => boolean;
  /** Why `surfacesIdentical` said no, for the veto diagnostic. */
  summarizeDivergence: (baseline: S, current: S) => Record<string, number>;
};

export type PostGestureStabilityOutcome<T> = {
  value: T;
  /**
   * `unsettled` when the deadline expired while the last two captures still disagreed.
   * `no-effect` ONLY when the accept-stale verdict is corroborated by full-surface evidence
   * (`surfacesIdentical`): the bare verdict is subset-tolerant by design, and a successful scroll
   * that replaced every list cell under fixed chrome still reads accept-stale (#1601 review P1).
   * Callers surface it to the agent: a diagnostics-only signal let one benchmark run burn 40 calls
   * re-issuing scrolls that moved nothing (#1600).
   */
  postGestureOutcome?: PostGestureOutcome;
};

/**
 * The agent-facing sentence for a post-gesture outcome, true whether the read that carries it found
 * its target or not. A no-effect gesture admits the honest ambiguity (at-edge is a legitimate no-op
 * the platform cannot distinguish) and hands over the escape hatch that moved a stuck list when
 * synthesized scrolls did not (#1600: raw `swipe` worked where scroll/fling/pan all no-opped).
 */
export function formatPostGestureOutcomeWarning({ kind, gesture }: PostGestureOutcome): string {
  const named = [gesture.action, ...gesture.positionals].join(' ').trim();
  return kind === 'unsettled'
    ? `The surface was still changing after ${named} when this tree was read, so it may not match where the surface comes to rest: an element missing from it is not proof of absence.`
    : `${named} produced no visible change: the tree still matches its pre-gesture state. ` +
        'Either the container is already at its edge, or it ignores synthesized scrolls — ' +
        'a raw drag moves such lists: swipe x1 y1 x2 y2 (start inside the list).';
}

function postGestureOutcome(
  kind: PostGestureOutcome['kind'],
  pending: PostGestureAction,
): PostGestureOutcome {
  return { kind, gesture: { action: pending.action, positionals: pending.positionals } };
}

/**
 * Verdict for a quiet match that has already been observed. Only a `pre-action` baseline can
 * distrust or accept stale: a `post-action` baseline was read after the gesture, and distrusting
 * it would hold the loop to the cap on every backend switch (#3868). A missing baseline trusts
 * outright. `'ambiguous'` evidence (no comparable content) falls through to `trust`, same as
 * `'changed'` — only a genuine "still equals the pre-gesture baseline" read keeps the loop
 * distrustful, and only until the bounded cap expires.
 */
export function decidePostGestureStabilityVerdict<S extends readonly unknown[]>(params: {
  baseline: PostGestureBaseline<S> | undefined;
  quietSignature: S;
  elapsedMs: number;
  distrustCapMs: number;
  classifyBaselineEvidence: (baseline: S, quiet: S) => BaselineSurfaceEvidence;
}): PostGestureStabilityDecision<S> {
  const { baseline, quietSignature, elapsedMs, distrustCapMs } = params;
  // An empty baseline is no baseline: never classify against it, whatever the classifier does
  // with empties. The writer normalizes `[]` away, so this guards a caller-constructed value.
  if (baseline?.provenance !== 'pre-action' || baseline.signature.length === 0) {
    return { verdict: 'trust' };
  }
  if (params.classifyBaselineEvidence(baseline.signature, quietSignature) !== 'unchanged') {
    return { verdict: 'trust' };
  }
  return elapsedMs < distrustCapMs
    ? { verdict: 'distrust' }
    : { verdict: 'accept-stale', preActionBaseline: baseline };
}

/**
 * The quiet-window stability verdict over the shared observation engine: keep
 * polling until two consecutive captures agree and the decision accepts the
 * agreement, or the (possibly distrust-extended) budget expires. Session
 * state never enters here — the caller owns the pending record's lifecycle
 * and clears it when this returns.
 */
export async function runPostGestureStabilityLoop<T, S extends readonly unknown[]>(params: {
  pending: PostGestureStabilityPending<S>;
  initial?: T;
  hooks: PostGestureStabilityHooks<T, S>;
  clock?: ObservationClock;
}): Promise<PostGestureStabilityOutcome<T>> {
  const { pending, hooks, clock } = params;
  const now = () => clock?.now() ?? Date.now();
  const startedAt = now();
  let attempts = 0;
  let baseline: PostGestureBaseline<S> | undefined = pending.baseline;
  // A rebase or a distrust verdict keeps polling on a pair that DID agree, so
  // the budget can expire on a surface that is already at rest.
  let lastPairAgreed = false;
  let surfaceCache: CapturedSurface<T, S> | undefined;

  const surfaceOf = (value: T): CapturedSurface<T, S> => {
    if (surfaceCache?.value === value) return surfaceCache;
    surfaceCache = { value, ...hooks.readSurface(value) };
    return surfaceCache;
  };

  const observed = await observeUntil<T, PostGestureStabilityOutcome<T>>({
    ...(params.initial !== undefined ? { initial: params.initial } : {}),
    capture: () => hooks.capture(),
    schedule: POST_GESTURE_STABILITY_SCHEDULE,
    ...(clock ? { clock } : {}),
    verdict: (latest, previousValue) => {
      attempts += 1;
      const current = surfaceOf(latest);
      if (previousValue === undefined) return { kind: 'continue' };

      const previous = surfaceOf(previousValue);
      lastPairAgreed = hooks.signaturesStable(previous.signature, current.signature);
      if (!lastPairAgreed) return { kind: 'continue' };

      const elapsedMs = now() - startedAt;
      // A capture plan may fall back or be pre-empted by the XCTest-channel penalty at any time,
      // so the serving surface can change mid-poll. This quiet pair says nothing about the
      // gesture: adopt it as a post-action baseline and keep going (#1569). The pair that rebases
      // cannot also settle the loop.
      if (baseline && baseline.comparisonKey !== current.comparisonKey) {
        emitDiagnostic({
          level: 'debug',
          phase: 'post_gesture_snapshot_baseline_rebased',
          data: {
            action: pending.action,
            from: baseline.comparisonKey,
            to: current.comparisonKey,
            attempts,
          },
        });
        // The adopted reading carries the new key: a further key change rebases again.
        baseline = {
          provenance: 'post-action',
          signature: current.signature,
          comparisonKey: current.comparisonKey,
        };
        return { kind: 'continue' };
      }
      const decision = decidePostGestureStabilityVerdict({
        baseline,
        quietSignature: current.signature,
        elapsedMs,
        distrustCapMs: STABILIZATION_DISTRUST_DEADLINE_MS,
        classifyBaselineEvidence: hooks.classifyBaselineEvidence,
      });
      if (decision.verdict === 'distrust') {
        return { kind: 'continue', budgetMs: STABILIZATION_DISTRUST_DEADLINE_MS };
      }
      emitSettleDiagnostic(decision.verdict, pending.action, attempts, elapsedMs);
      return {
        kind: 'done',
        result: buildAcceptedOutcome(decision, pending, current, hooks),
      };
    },
  });

  if (observed.kind === 'done') return observed.result;
  if (observed.kind === 'failed') throw observed.error;

  emitDiagnostic({
    level: 'warn',
    phase: 'post_gesture_snapshot_stabilization_timeout',
    data: {
      action: pending.action,
      attempts,
      durationMs: observed.waitedMs,
      lastPairAgreed,
    },
  });
  // minPolls guarantees at least one judged value before an `expired` end can fire.
  const value = observed.last as T;
  if (lastPairAgreed) return { value };
  return { value, postGestureOutcome: postGestureOutcome('unsettled', pending) };
}

type CapturedSurface<T, S> = PostGestureSurfaceReading<S> & {
  value: T;
};

function emitSettleDiagnostic(
  verdict: 'trust' | 'accept-stale',
  action: string,
  attempts: number,
  durationMs: number,
): void {
  if (verdict === 'accept-stale') {
    emitDiagnostic({
      level: 'warn',
      phase: 'post_gesture_snapshot_stale_accept',
      data: { action, attempts, durationMs, matchedPreGestureBaseline: true },
    });
    return;
  }
  emitDiagnostic({
    level: attempts > 2 ? 'info' : 'debug',
    phase: 'post_gesture_snapshot_stabilized',
    data: { action, attempts, durationMs },
  });
}

/**
 * The no-effect claim needs BOTH the accept-stale verdict AND full-surface
 * corroboration (`surfacesIdentical`) against the pre-action baseline the verdict carries — never a
 * lookup back into the pending record. The verdict alone is subset-tolerant (#1601 review P1), and
 * a rebased baseline cannot produce accept-stale at all, so a backend flip cannot launder a
 * cross-backend pair into a no-effect claim.
 *
 * A veto here is invisible from the outside: the response looks exactly like
 * a gesture that worked. #1620 could not tell the two apart on live hostile
 * screens, so every veto records the divergence counts that failed set
 * equality.
 */
function buildAcceptedOutcome<T, S extends readonly unknown[]>(
  decision: PostGestureStabilityDecision<S>,
  pending: PostGestureStabilityPending<S>,
  current: CapturedSurface<T, S>,
  hooks: PostGestureStabilityHooks<T, S>,
): PostGestureStabilityOutcome<T> {
  if (decision.verdict !== 'accept-stale') return { value: current.value };
  const baseline = decision.preActionBaseline;
  if (hooks.surfacesIdentical(baseline.signature, current.signature)) {
    return { value: current.value, postGestureOutcome: postGestureOutcome('no-effect', pending) };
  }
  emitDiagnostic({
    level: 'info',
    phase: 'post_gesture_no_effect_vetoed',
    data: {
      action: pending.action,
      backend: current.comparisonKey,
      reason: 'surface_divergence',
      ...hooks.summarizeDivergence(baseline.signature, current.signature),
    },
  });
  return { value: current.value };
}
