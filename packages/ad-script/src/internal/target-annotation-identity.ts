/**
 * ADR 0012 decision 3: the record/replay-shared local-identity + ancestry-
 * prefix matching over versioned `.ad` target-binding evidence, plus the
 * bounded diagnostic diffs built on top of it. Both the writer (over
 * `SnapshotNode`-derived values, `src/daemon/session-target-evidence.ts`) and
 * replay-time verification (`src/daemon/handlers/session-replay-target-classification.ts`,
 * `src/commands/interaction/runtime/selector-wait.ts`, and the shared
 * replay-zone tree helpers in `src/replay/`) share this verbatim so both
 * sides compute the SAME identity/ancestry match by construction (#1478 P5
 * review, "genuinely shared recording vocabulary" relocated to its owner).
 *
 * The classification core built on top of this (`classifyTargetBindingMatch`,
 * decision 3's replay-time verification paths 2-6) lives alongside this file
 * in `target-annotation-classification.ts` — both daemon-only consumers
 * (record-time self-check and replay-time classification) reach it from
 * here, not through `@agent-device/ad-replay`'s façade (#1555 review).
 */

import type { TargetAncestryEntry, TargetAnnotationV1 } from '@agent-device/contracts/replay';

// ---------------------------------------------------------------------------
// Local identity + ancestry-prefix matching (decision 3 "Local identity" /
// "Ancestry"). Pure over the small structural shapes above — no tree
// dependency, so both the writer (over `SnapshotNode`-derived values) and a
// replay verifier can share it verbatim.
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
// Diagnostic diffs (decision 3): bounded, best-effort mismatch descriptions
// shared by the record-time classification core and replay-time verification
// (#1478 P5 stage C2a) — moved here verbatim from
// `src/daemon/handlers/session-replay-target-classification.ts` so both
// callers depend on one definition instead of two copies.
// ---------------------------------------------------------------------------

export function identityFieldMismatches(
  recorded: TargetAnnotationV1,
  observed: LocalIdentity,
): string[] {
  const mismatches: string[] = [];
  if (recorded.id !== observed.id) {
    mismatches.push(`id: recorded=${recorded.id ?? '(none)'} observed=${observed.id ?? '(none)'}`);
  }
  if (recorded.role !== observed.role) {
    mismatches.push(`role: recorded=${recorded.role} observed=${observed.role}`);
  }
  if (recorded.label !== observed.label) {
    mismatches.push(
      `label: recorded=${recorded.label ?? '(none)'} observed=${observed.label ?? '(none)'}`,
    );
  }
  return mismatches;
}

function describeAncestryEntry(entry: TargetAncestryEntry | undefined): string {
  return entry ? `${entry.role}${entry.label ? `/${entry.label}` : ''}` : '(missing)';
}

function ancestryEntryMismatches(
  expected: TargetAncestryEntry,
  actual: TargetAncestryEntry | undefined,
): boolean {
  if (!actual) return true;
  if (actual.role !== expected.role) return true;
  return expected.label !== undefined && actual.label !== expected.label;
}

/** Leaf-anchored prefix: the first divergence explains everything after it. */
export function firstAncestryMismatch(
  recordedAncestry: readonly TargetAncestryEntry[],
  observedAncestry: readonly TargetAncestryEntry[],
): string[] {
  for (const [index, expected] of recordedAncestry.entries()) {
    const actual = observedAncestry[index];
    if (!ancestryEntryMismatches(expected, actual)) continue;
    return [
      `ancestry[${index}]: recorded=${describeAncestryEntry(expected)} observed=${describeAncestryEntry(actual)}`,
    ];
  }
  return [];
}
