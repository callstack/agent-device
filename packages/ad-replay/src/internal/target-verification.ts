/**
 * #1478 P5 stage C2a: the target-verification ENGINE policy — moved verbatim
 * out of `src/daemon/handlers/session-replay-target-verification.ts`, which
 * keeps the DAEMON-AUTHORITY half (capture, `SessionStore`, resume stamping,
 * wire projection into `DaemonResponse`). This module decides, over already-
 * available plain values, whether/how a recorded target-binding annotation
 * should be verified — never itself touching a snapshot capture, a session,
 * or a wire response.
 *
 * Two pure decisions live here:
 *
 *  - `planPostResolutionTargetVerification` / `planPreDispatchTargetVerification`:
 *    should `verifyReplayActionTarget` even attempt verification, and with
 *    what token — mirrors the two branches of that function's original
 *    pre-capture gating exactly (#1349's deferred-landmark `wait` case, and
 *    the ordinary pre-dispatch token/parse gate).
 *  - `deriveReplayTargetGuardMismatchEvidence` / `deriveWaitLandmarkMismatchEvidence`:
 *    given the recorded evidence and a post-dispatch refusal's raw (already
 *    neutral, `unknown`-typed) details bag, compute the observed identity and
 *    mismatch lines a target-binding divergence reports — the daemon then
 *    wraps the result into a `DaemonResponse`.
 */

import type { TargetAncestryEntry, TargetAnnotationV1 } from '@agent-device/contracts/replay';
import type { Platform, PublicPlatform } from '@agent-device/kernel/device';
import {
  firstAncestryMismatch,
  identityFieldMismatches,
  type LocalIdentity,
} from '@agent-device/ad-script';
import type { ReplaySelectorPort } from './selector-port.ts';

// ---------------------------------------------------------------------------
// Pre-capture verification gating (`verifyReplayActionTarget`'s two branches).
// ---------------------------------------------------------------------------

export type ReplayPostResolutionVerificationPlan =
  | { kind: 'skip' }
  | { kind: 'recorded-unverifiable' }
  | { kind: 'deferred-landmark'; landmark: TargetAnnotationV1 };

/**
 * #1349 post-resolution phase (`wait`): only a selector wait names a
 * landmark — an annotation on any other wait form is inert, like an old
 * reader. A verifiable landmark defers into the wait's own polling loop
 * rather than refusing on the current screen (an absent landmark is a wait's
 * expected starting condition).
 */
export function planPostResolutionTargetVerification(params: {
  recorded: TargetAnnotationV1;
  isSelectorWait: boolean;
}): ReplayPostResolutionVerificationPlan {
  const { recorded, isSelectorWait } = params;
  if (!isSelectorWait) return { kind: 'skip' };
  if (recorded.verification === 'unverifiable') return { kind: 'recorded-unverifiable' };
  return { kind: 'deferred-landmark', landmark: recorded };
}

export type ReplayPreDispatchVerificationPlan =
  | { kind: 'skip' }
  | { kind: 'recorded-unverifiable' }
  | { kind: 'verify'; token: string };

/**
 * The ordinary pre-dispatch gate: no recorded token means nothing to verify;
 * a malformed recorded selector is not this module's concern (the real
 * dispatch parses, and fails, it the same way an unannotated action would —
 * `resolveRecordedTarget`'s own parse gate over empty `nodes` is the same
 * `tryParseSelectorChain` check this used to run directly); only past both
 * of those does a recorded-`unverifiable` annotation refuse pre-action.
 */
export function planPreDispatchTargetVerification(params: {
  recorded: TargetAnnotationV1;
  token: string | undefined;
  platform: Platform | PublicPlatform;
  port: ReplaySelectorPort;
}): ReplayPreDispatchVerificationPlan {
  const { recorded, token, platform, port } = params;
  if (token === undefined) return { kind: 'skip' };
  if (!token.startsWith('@')) {
    const parseCheck = port.resolveRecordedTarget(token, [], {
      platform,
      requireRect: false,
      allowDisambiguation: false,
    });
    if (parseCheck.kind === 'unresolved' && parseCheck.reason === 'parse-invalid') {
      return { kind: 'skip' };
    }
  }
  if (recorded.verification === 'unverifiable') return { kind: 'recorded-unverifiable' };
  return { kind: 'verify', token };
}

// ---------------------------------------------------------------------------
// Post-dispatch identity-mismatch evidence (the guard mismatch and the wait
// landmark mismatch): both refusal markers arrive as a failed dispatch
// response whose `details` carry the observed evidence; this derives the
// SAME bounded identity-mismatch shape around their marker-specific evidence
// the daemon used to compute inline.
// ---------------------------------------------------------------------------

export type ReplayPostDispatchMismatchEvidence = {
  matchCount: number | undefined;
  observed: LocalIdentity | undefined;
  mismatches: string[];
  causeMessage: string;
};

export function readGuardMismatchObservedIdentity(value: unknown): LocalIdentity | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.role !== 'string') return undefined;
  return {
    ...(typeof record.id === 'string' ? { id: record.id } : {}),
    role: record.role,
    ...(typeof record.label === 'string' ? { label: record.label } : {}),
  };
}

/** The wait refusal's `observedAncestry` entries, defensively re-read off error details. */
export function readAncestryEntries(value: unknown): TargetAncestryEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: TargetAncestryEntry[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    if (typeof record.role !== 'string') return [];
    entries.push({
      role: record.role,
      ...(typeof record.label === 'string' ? { label: record.label } : {}),
    });
  }
  return entries;
}

function readStructuralDenotation(
  value: unknown,
): { documentOrder: number; sibling: number } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.documentOrder !== 'number' || typeof record.sibling !== 'number') {
    return undefined;
  }
  return { documentOrder: record.documentOrder, sibling: record.sibling };
}

/** A `position:` mismatch line from the guard's structural denotations, when both are present and differ. */
export function describeStructuralMismatch(
  expected: unknown,
  observed: unknown,
): string | undefined {
  const e = readStructuralDenotation(expected);
  const o = readStructuralDenotation(observed);
  if (!e || !o) return undefined;
  if (e.documentOrder === o.documentOrder && e.sibling === o.sibling) return undefined;
  return `position: recorded=doc${e.documentOrder}/sibling${e.sibling} observed=doc${o.documentOrder}/sibling${o.sibling}`;
}

/**
 * Dispatch resolution (with occlusion/visibility guards) resolved a
 * different element than pre-action verification isolated. `matchCount` is
 * the caller's already-known verified-member match count (verification's
 * own recorded-selector match count) — never re-derived from `details`.
 */
export function deriveReplayTargetGuardMismatchEvidence(
  recorded: TargetAnnotationV1,
  details: Record<string, unknown> | undefined,
  matchCount: number,
): ReplayPostDispatchMismatchEvidence {
  const observed = readGuardMismatchObservedIdentity(details?.observed);
  // The guard fires even when local identity is identical (a same-identity
  // duplicate resolved by structural position) — surface the structural
  // difference so `mismatches` is never empty on a real divergence.
  const structuralMismatch = describeStructuralMismatch(
    details?.expectedStructural,
    details?.observedStructural,
  );
  return {
    matchCount,
    observed,
    mismatches: [
      ...(observed ? identityFieldMismatches(recorded, observed) : []),
      ...(structuralMismatch ? [structuralMismatch] : []),
    ],
    causeMessage:
      'Dispatch resolution (with occlusion/visibility guards) resolved a different element than pre-action verification isolated; the action was not sent.',
  };
}

/**
 * Candidates matched the recorded wait selector during polling, but none
 * carried the recorded landmark identity before the timeout.
 */
export function deriveWaitLandmarkMismatchEvidence(
  recorded: TargetAnnotationV1,
  details: Record<string, unknown> | undefined,
): ReplayPostDispatchMismatchEvidence {
  const observed = readGuardMismatchObservedIdentity(details?.observed);
  const observedAncestry = readAncestryEntries(details?.observedAncestry);
  return {
    matchCount: typeof details?.matchCount === 'number' ? details.matchCount : undefined,
    observed,
    mismatches: observed
      ? [
          ...identityFieldMismatches(recorded, observed),
          ...firstAncestryMismatch(recorded.ancestry, observedAncestry),
        ]
      : [],
    causeMessage:
      'Candidates matched the recorded wait selector during polling, but none carried the recorded landmark identity before the timeout; the wait did not report success.',
  };
}
