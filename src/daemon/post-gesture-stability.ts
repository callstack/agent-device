import { emitDiagnostic } from '../utils/diagnostics.ts';
import { sleep } from '../utils/timeouts.ts';

/**
 * Pure post-gesture stability mechanics: the quiet-window polling loop and the
 * baseline-distrust verdict, parameterized over the capture value and the
 * signature comparators. Deliberately a leaf — it imports no cycle owners and
 * no `SessionState`, so it stays outside the R9 type cycle while the
 * deferred-interaction-outcome owner (which holds the pending record and the
 * session mutation) stays the one seam callers see. The owner supplies the
 * comparators from interaction-outcome-policy; their semantics (subset
 * tolerance, identity keying, discriminating entries) are documented there.
 */

const STABILIZATION_DEADLINE_MS = 1_500;
const STABILIZATION_INTERVAL_MS = 200;
const STABILIZATION_MIN_ATTEMPTS = 2;

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
const STABILIZATION_DISTRUST_DEADLINE_MS = STABILIZATION_DEADLINE_MS + 2_000;

export type BaselineSurfaceEvidence = 'changed' | 'unchanged' | 'ambiguous';

export type PostGestureStabilityVerdict = 'trust' | 'distrust' | 'accept-stale';

export type PostGestureStabilityPending<S> = {
  action: string;
  positionals: string[];
  baselineSignature?: S;
  baselineBackend?: string;
};

export type PostGestureStabilityHooks<T, S extends readonly unknown[]> = {
  capture: () => Promise<T>;
  /** Signature + capture backend of one attempt, for quiet-window comparison. */
  readSurface: (value: T) => { signature: S; backend: string | undefined };
  /** Two consecutive polls agree — the quiet-window test. */
  signaturesStable: (previous: S, current: S) => boolean;
  /** Subset-tolerant baseline comparison feeding the distrust verdict. */
  classifyBaselineEvidence: (baseline: S, quiet: S) => BaselineSurfaceEvidence;
  /** Full-surface both-direction agreement — the no-effect corroboration bar. */
  surfacesIdentical: (baseline: S, current: S) => boolean;
};

export type PostGestureStabilityOutcome<T> = {
  value: T;
  /**
   * Present ONLY when the accept-stale verdict is corroborated by full-surface
   * evidence (`surfacesIdentical`). The bare verdict is NOT enough — it is
   * subset-tolerant by design, and a successful scroll that replaced every
   * list cell under fixed chrome still reads accept-stale (#1601 review P1).
   * Callers surface this to the agent: a diagnostics-only signal let one
   * benchmark run burn 40 calls re-issuing scrolls that moved nothing (#1600).
   */
  gestureNoEffect?: { action: string; positionals: string[] };
};

/**
 * Verdict for a quiet match that has already been observed. `'ambiguous'`
 * baseline evidence (no comparable content) falls through to `trust`, same as
 * `'changed'` — only a genuine "still equals the pre-gesture baseline" read
 * keeps the loop distrustful, and only until the bounded cap expires.
 */
export function decidePostGestureStabilityVerdict<S extends readonly unknown[]>(params: {
  needsBaselineDistrust: boolean;
  baselineSignature: S | undefined;
  quietSignature: S;
  elapsedMs: number;
  distrustCapMs: number;
  classifyBaselineEvidence: (baseline: S, quiet: S) => BaselineSurfaceEvidence;
}): PostGestureStabilityVerdict {
  const { needsBaselineDistrust, baselineSignature, quietSignature, elapsedMs, distrustCapMs } =
    params;
  if (!needsBaselineDistrust || !baselineSignature?.length) return 'trust';
  if (params.classifyBaselineEvidence(baselineSignature, quietSignature) !== 'unchanged') {
    return 'trust';
  }
  return elapsedMs < distrustCapMs ? 'distrust' : 'accept-stale';
}

/**
 * The quiet-window stability loop: poll until two consecutive captures agree
 * and the verdict accepts the agreement, or the (possibly distrust-extended)
 * deadline expires. Session state never enters here — the caller owns the
 * pending record's lifecycle and clears it when this returns.
 */
export async function runPostGestureStabilityLoop<T, S extends readonly unknown[]>(params: {
  pending: PostGestureStabilityPending<S>;
  needsBaselineDistrust: boolean;
  initial?: T;
  hooks: PostGestureStabilityHooks<T, S>;
}): Promise<PostGestureStabilityOutcome<T>> {
  const { pending, needsBaselineDistrust, hooks } = params;
  const startedAt = Date.now();
  let attempts = 1;
  let previous = await captureSurface(hooks, params.initial);
  let baselineSignature = pending.baselineSignature;
  let baselineBackend = pending.baselineBackend;
  // Extended past STABILIZATION_DEADLINE_MS only when the distrust verdict
  // fires below; the ordinary (non-distrust) timeout path is unaffected.
  let effectiveDeadlineMs = STABILIZATION_DEADLINE_MS;

  while (attempts < STABILIZATION_MIN_ATTEMPTS || Date.now() - startedAt < effectiveDeadlineMs) {
    await sleep(STABILIZATION_INTERVAL_MS);
    attempts += 1;
    const current = await captureSurface(hooks);
    if (hooks.signaturesStable(previous.signature, current.signature)) {
      const elapsedMs = Date.now() - startedAt;
      // A capture plan may fall back or be pre-empted by the XCTest-channel
      // penalty at any time, so the backend can change mid-poll. Backends do
      // not agree on which nodes exist, so this pair says nothing about the
      // gesture: adopt it as the baseline and keep going rather than concluding
      // from it (#1569).
      if (baselineSignature && baselineBackend !== current.backend) {
        emitDiagnostic({
          level: 'debug',
          phase: 'post_gesture_snapshot_baseline_rebased',
          data: { action: pending.action, from: baselineBackend, to: current.backend, attempts },
        });
        baselineSignature = current.signature;
        baselineBackend = current.backend;
        previous = current;
        continue;
      }
      const verdict = decidePostGestureStabilityVerdict({
        needsBaselineDistrust,
        baselineSignature,
        quietSignature: current.signature,
        elapsedMs,
        distrustCapMs: STABILIZATION_DISTRUST_DEADLINE_MS,
        classifyBaselineEvidence: hooks.classifyBaselineEvidence,
      });
      if (verdict === 'distrust') {
        effectiveDeadlineMs = STABILIZATION_DISTRUST_DEADLINE_MS;
        previous = current;
        continue;
      }
      emitSettleDiagnostic(verdict, pending.action, attempts, elapsedMs);
      return buildAcceptedOutcome(verdict, pending, current, hooks);
    }
    previous = current;
  }

  emitDiagnostic({
    level: 'warn',
    phase: 'post_gesture_snapshot_stabilization_timeout',
    data: {
      action: pending.action,
      attempts,
      durationMs: Date.now() - startedAt,
    },
  });
  return { value: previous.value };
}

type CapturedSurface<T, S> = {
  value: T;
  signature: S;
  backend: string | undefined;
};

async function captureSurface<T, S extends readonly unknown[]>(
  hooks: PostGestureStabilityHooks<T, S>,
  initial?: T,
): Promise<CapturedSurface<T, S>> {
  const value = initial ?? (await hooks.capture());
  return { value, ...hooks.readSurface(value) };
}

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
 * corroboration (`surfacesIdentical`) against the ORIGINAL pre-gesture
 * baseline — deliberately NOT a mid-loop rebased one, so a backend flip can
 * never launder a cross-backend pair into a no-effect claim. The verdict
 * alone is subset-tolerant (#1601 review P1).
 */
function buildAcceptedOutcome<T, S extends readonly unknown[]>(
  verdict: 'trust' | 'accept-stale',
  pending: PostGestureStabilityPending<S>,
  current: CapturedSurface<T, S>,
  hooks: PostGestureStabilityHooks<T, S>,
): PostGestureStabilityOutcome<T> {
  const corroborated =
    verdict === 'accept-stale' &&
    pending.baselineSignature !== undefined &&
    hooks.surfacesIdentical(pending.baselineSignature, current.signature);
  if (!corroborated) return { value: current.value };
  return {
    value: current.value,
    gestureNoEffect: {
      action: pending.action,
      positionals: pending.positionals,
    },
  };
}
