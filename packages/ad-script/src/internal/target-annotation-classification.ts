/**
 * ADR 0012 decision 3: the record/replay-shared CLASSIFICATION core over
 * versioned `.ad` target-binding evidence — `classifyTargetBindingMatch`'s
 * replay-time verification paths 2-6. Inert in migration step 3: nothing
 * enforces parsed evidence at replay time until step 4.
 *
 * #1555 review P1 ("complete the binding façade instead of documenting
 * deviations"): this used to live in `@agent-device/ad-replay`'s
 * `target-identity.ts`, reasoning that it was engine-owned policy rather
 * than script vocabulary. In practice its only real consumers were the
 * daemon's RECORD-time self-check (`src/daemon/session-target-evidence.ts`)
 * and its REPLAY-time classification wrapper
 * (`src/daemon/replay/internal/session-replay-target-classification.ts`) — both
 * daemon files, neither reachable through `inspectAdReplay`/`runAdReplay`.
 * It interprets `TargetAnnotationV1` evidence semantics shared beyond the
 * engine (record-time AND replay-time both need the SAME verdict by
 * construction), so it belongs alongside the rest of that shared `.ad`
 * target-binding vocabulary in this package rather than behind a façade
 * only one of its two callers could reach.
 */

// ---------------------------------------------------------------------------
// Classification core (decision 3 "Replay-time verification", paths 2-6;
// path 1 is the caller's pre-resolution check). Generic over node refs so
// the record-time self-check and future replay-time enforcement share it.
// ---------------------------------------------------------------------------

export type TargetBindingClassificationInput = {
  /** The node the resolver actually picked. */
  winnerRef: string;
  /** `matchCount`'s domain: nodes matching the recorded selector/ref. */
  matchedRefs: readonly string[];
  /** Members of `matchedRefs` sharing the recorded local identity + ancestry prefix (decision 3 set I). */
  identitySetRefs: readonly string[];
  /** Members of `identitySetRefs` whose same-parent sibling ordinal equals the recorded `sibling`. */
  siblingMatchRefs: readonly string[];
  /**
   * Members of `identitySetRefs` in the partition whose scroll-region key
   * equals the recorded `scrollRegion` (the *none* partition when none was
   * recorded). `undefined` when that region no longer exists at all.
   */
  regionMemberRefs: readonly string[] | undefined;
  /** `regionMemberRefs` ordered by decision 3's viewport ordering; the ref at the recorded `viewportOrder`, if in range. */
  viewportCandidateRef: string | undefined;
};

/**
 * Decision 3 keeps two spec-distinct failure classes inside path 6, and the
 * `reason` field preserves the distinction for migration step 4's divergence
 * `kind` mapping:
 *
 * - a disambiguation signal ISOLATING exactly one member that differs from
 *   the winner is "compare with W as in paths 4/5" — the same class as path
 *   5's unique-but-wrong rebind, i.e. a future `identity-mismatch`
 *   (`signal-isolated-wrong`);
 * - neither signal isolating any member is the true fall-through — a future
 *   `identity-unverifiable` with up to 5 candidates (`no-signal-isolation`).
 */
export type TargetBindingClassification =
  | { path: 2; outcome: 'unverifiable'; reason: 'selector-miss' }
  | { path: 3; outcome: 'unverifiable'; reason: 'identity-set-empty' }
  | { path: 4; outcome: 'verified' }
  | { path: 5; outcome: 'unverifiable'; reason: 'unique-but-wrong' }
  | { path: 6; outcome: 'verified' }
  | { path: 6; outcome: 'unverifiable'; reason: 'signal-isolated-wrong' | 'no-signal-isolation' };

/**
 * Decision 3 "Replay-time verification", paths 2-6. `matchCount == 0` (path
 * 2), an empty identity set (path 3), a unique identity-set member that is or
 * isn't the winner (paths 4/5), and the sibling → region-scoped-viewportOrder
 * disambiguation cascade (path 6) — falling through to unverifiable, never a
 * silent pick, exactly as decision 3 specifies.
 */
export function classifyTargetBindingMatch(
  input: TargetBindingClassificationInput,
): TargetBindingClassification {
  if (input.matchedRefs.length === 0) {
    return { path: 2, outcome: 'unverifiable', reason: 'selector-miss' };
  }
  if (input.identitySetRefs.length === 0) {
    return { path: 3, outcome: 'unverifiable', reason: 'identity-set-empty' };
  }
  if (input.identitySetRefs.length === 1) {
    return input.identitySetRefs[0] === input.winnerRef
      ? { path: 4, outcome: 'verified' }
      : { path: 5, outcome: 'unverifiable', reason: 'unique-but-wrong' };
  }
  if (input.siblingMatchRefs.length === 1) {
    // The sibling signal isolates exactly one member: the evidence denotes
    // it — compare with the winner as in paths 4/5 (decision 3, path 6.i).
    return input.siblingMatchRefs[0] === input.winnerRef
      ? { path: 6, outcome: 'verified' }
      : { path: 6, outcome: 'unverifiable', reason: 'signal-isolated-wrong' };
  }
  if (
    input.regionMemberRefs !== undefined &&
    input.regionMemberRefs.length > 0 &&
    input.viewportCandidateRef !== undefined
  ) {
    // Region-scoped viewportOrder denotes a member: compare as in paths 4/5
    // (decision 3, path 6.ii).
    return input.viewportCandidateRef === input.winnerRef
      ? { path: 6, outcome: 'verified' }
      : { path: 6, outcome: 'unverifiable', reason: 'signal-isolated-wrong' };
  }
  return { path: 6, outcome: 'unverifiable', reason: 'no-signal-isolation' };
}
