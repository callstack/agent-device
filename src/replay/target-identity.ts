/**
 * ADR 0012 decision 3: the record/replay-shared CLASSIFICATION core over
 * versioned `.ad` target-binding evidence — local-identity + ancestry-prefix
 * matching, and `classifyTargetBindingMatch`'s replay-time verification
 * paths 2-6. Inert in migration step 3: nothing enforces parsed evidence at
 * replay time until step 4.
 *
 * The comment-line SERDE half (wire type, canonical field order,
 * normalization, size caps, payload parsing/validation) moved to
 * `@agent-device/ad-script` (#1478 P5 scoping dossier, "the codec seam") —
 * this module imports the shared types from there rather than declaring them.
 */

import type { TargetAncestryEntry, TargetAnnotationV1 } from '@agent-device/ad-script';

// ---------------------------------------------------------------------------
// Local identity + ancestry-prefix matching (decision 3 "Local identity" /
// "Ancestry"). Pure over the small structural shapes above — no tree
// dependency, so both the writer (over `SnapshotNode`-derived values) and a
// future replay verifier can share it verbatim.
// ---------------------------------------------------------------------------

export type LocalIdentity = { id?: string; role: string; label?: string };

/** The recorded annotation's identity tier as a bare `LocalIdentity` (drop-empty-keys form). */
export function annotationLocalIdentity(
  recorded: Pick<TargetAnnotationV1, 'id' | 'role' | 'label'>,
): LocalIdentity {
  return {
    ...(recorded.id !== undefined ? { id: recorded.id } : {}),
    role: recorded.role,
    ...(recorded.label !== undefined ? { label: recorded.label } : {}),
  };
}

/**
 * Decision 3 "Local identity": id match wins outright when the recording
 * carries one ("a recorded id never matches a node without that id"); with
 * no recorded id, role+label must both match (label absent on both sides
 * counts as equal; present on exactly one side is a mismatch).
 */
export function matchesLocalIdentity(candidate: LocalIdentity, recorded: LocalIdentity): boolean {
  if (recorded.id !== undefined) return candidate.id === recorded.id;
  return candidate.role === recorded.role && candidate.label === recorded.label;
}

/**
 * Decision 3 "Ancestry": leaf-anchored prefix match. `observed` must be at
 * least as long as `recorded`; each recorded entry's role must match exactly
 * and, when the recorded entry carries a label, so must the observed one (an
 * absent recorded label is unconstrained).
 */
export function matchesAncestryPrefix(
  observed: readonly TargetAncestryEntry[],
  recorded: readonly TargetAncestryEntry[],
): boolean {
  if (observed.length < recorded.length) return false;
  for (const [index, entry] of recorded.entries()) {
    const candidate = observed[index];
    if (!candidate) return false;
    if (candidate.role !== entry.role) return false;
    if (entry.label !== undefined && candidate.label !== entry.label) return false;
  }
  return true;
}

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
