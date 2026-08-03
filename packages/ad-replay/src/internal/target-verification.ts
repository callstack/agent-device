/**
 * #1478 P5 stage C2a: the target-verification ENGINE policy — moved verbatim
 * out of `src/daemon/handlers/session-replay-target-verification.ts`, which
 * keeps the DAEMON-AUTHORITY half (capture, `SessionStore`, resume stamping,
 * wire projection into `DaemonResponse`). This module decides, over already-
 * available plain values, whether/how a recorded target-binding annotation
 * should be verified — never itself touching a snapshot capture, a session,
 * or a wire response.
 *
 * #1555 review R3 ("target verification must happen INSIDE the engine"): the
 * four functions below are called ONLY from `./step-loop.ts`'s
 * `verifyAndDispatchStep` — the engine's own step loop, never the daemon —
 * and are NOT re-exported by the package façade (`../index.ts`). The daemon
 * (`session-replay-target-verification.ts`) now implements only the narrow
 * `AdReplayStepRuntime` capabilities `verifyAndDispatchStep` drives (routing,
 * capture, classification, dispatch, wire-building); it never imports this
 * module.
 *
 * Two pure decisions live here:
 *
 *  - `planPostResolutionTargetVerification` / `planPreDispatchTargetVerification`:
 *    should the step loop even attempt verification, and with what token —
 *    mirrors the two branches of the pre-#1555-R3 daemon orchestrator's
 *    original pre-capture gating exactly (#1349's deferred-landmark `wait`
 *    case, and the ordinary pre-dispatch token/parse gate).
 *  - `deriveReplayTargetGuardMismatchEvidence` / `deriveWaitLandmarkMismatchEvidence`:
 *    given the recorded evidence and a post-dispatch refusal's TYPED evidence
 *    (`AdReplayGuardMismatchEvidence`/`AdReplayLandmarkMismatchEvidence`),
 *    compute the observed identity and mismatch lines a target-binding
 *    divergence reports — the daemon then wraps the result into a
 *    `DaemonResponse`.
 *
 * #1555 review P1 (second pass, "translate wire failures before the engine
 * boundary"): the two derive functions used to take the wire response's raw
 * `details: Record<string, unknown> | undefined` bag directly — a daemon
 * wire shape crossing into the engine despite carrying no `DaemonResponse`
 * itself. The daemon adapter (`session-replay-runtime-engine-adapter.ts`)
 * now narrows that bag into the typed `AdReplayGuardMismatchEvidence`/
 * `AdReplayLandmarkMismatchEvidence` shapes below BEFORE constructing the
 * `AdReplayDispatchOutcome` the engine sees — the `unknown`-parsing readers
 * that used to live here (`readGuardMismatchObservedIdentity`,
 * `readAncestryEntries`, an anonymous structural-denotation reader) moved
 * there with it, since reading an untyped wire bag is wire-projection work,
 * not engine policy. This module now only reads already-typed values.
 */

import type { TargetAncestryEntry, TargetAnnotationV1 } from '@agent-device/contracts/replay';
import {
  firstAncestryMismatch,
  identityFieldMismatches,
  type LocalIdentity,
} from '@agent-device/ad-script';
import type { ReplaySelectorPort } from './selector-port.ts';

/**
 * The verified/observed member's structural position within its capture
 * (document order + sibling) — moved here (from `./step-loop.ts`, which
 * still uses it for `AdReplayVerifiedTargetGuard`) so both this module's
 * typed evidence shapes and the step loop can reference ONE definition
 * without a cycle: this module has no dependency on `./step-loop.ts`, but
 * `./step-loop.ts` already depends on this one.
 */
export type AdReplayTargetStructuralDenotation = Readonly<{
  documentOrder: number;
  sibling: number;
}>;

/**
 * The guard-mismatch refusal's typed evidence, already narrowed by the
 * daemon adapter from the wire response's `details` bag — the engine never
 * sees the untyped bag itself.
 */
export type AdReplayGuardMismatchEvidence = Readonly<{
  observed: LocalIdentity | undefined;
  expectedStructural: AdReplayTargetStructuralDenotation | undefined;
  observedStructural: AdReplayTargetStructuralDenotation | undefined;
}>;

/** The wait-landmark-mismatch refusal's typed evidence — same translate-before-crossing rule. */
export type AdReplayLandmarkMismatchEvidence = Readonly<{
  matchCount: number | undefined;
  observed: LocalIdentity | undefined;
  observedAncestry: readonly TargetAncestryEntry[];
}>;

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
 * dispatch parses, and fails, it the same way an unannotated action would);
 * only past that does a recorded-`unverifiable` annotation refuse pre-action.
 *
 * #1555 structural-quality review ("fix the engine's parse gate to honor its
 * own port contract"): the parse check used to call `resolveRecordedTarget`
 * over an EMPTY tree purely to read its `parse-invalid` reason — a resolve
 * call standing in for a parse call, and the one call site in this package
 * that never used `readSelectorExpression` (operation 1 of the port's own
 * three-operation contract) despite existing to answer exactly this
 * question. `readSelectorExpression('ordinary', [token])` is the real parse
 * check now.
 *
 * The outcome mapping is NOT `'invalid' -> skip` on the production adapter:
 * `readSelectorExpression`'s `'ordinary'`/`'wait'` grammars
 * (`splitSelectorFromArgs`) only ever record a prefix boundary once it has
 * already parsed, so a single already-whole token that fails to parse can
 * only come back `'not-applicable'` (no selector-shaped boundary was ever
 * found) — production's `'invalid'` case is structurally unreachable from
 * this call site (see `selector-port-contract.test.ts`'s "ordinary bare
 * token: production vs. in-memory 'invalid' reachability" cell, which pins
 * this precisely and documents where the two adapters legitimately diverge).
 * Both non-`'expression'` outcomes are treated identically here — the
 * historical behavior this replaces made no distinction either (a single
 * `parse-invalid` reason covered both "not selector-shaped at all" and
 * "selector-shaped but malformed").
 */
export function planPreDispatchTargetVerification(params: {
  recorded: TargetAnnotationV1;
  token: string | undefined;
  port: ReplaySelectorPort;
}): ReplayPreDispatchVerificationPlan {
  const { recorded, token, port } = params;
  if (token === undefined) return { kind: 'skip' };
  if (!token.startsWith('@')) {
    const parseCheck = port.readSelectorExpression('ordinary', [token]);
    if (parseCheck.kind !== 'expression') {
      return { kind: 'skip' };
    }
  }
  if (recorded.verification === 'unverifiable') return { kind: 'recorded-unverifiable' };
  return { kind: 'verify', token };
}

// ---------------------------------------------------------------------------
// Post-dispatch identity-mismatch evidence (the guard mismatch and the wait
// landmark mismatch): both refusal markers arrive as a failed dispatch whose
// TYPED evidence (`AdReplayGuardMismatchEvidence`/`AdReplayLandmarkMismatchEvidence`,
// already narrowed by the daemon adapter from the wire response) carries the
// observed evidence; this derives the SAME bounded identity-mismatch shape
// around it the daemon used to compute inline.
// ---------------------------------------------------------------------------

export type ReplayPostDispatchMismatchEvidence = {
  matchCount: number | undefined;
  observed: LocalIdentity | undefined;
  mismatches: string[];
  causeMessage: string;
};

/** A `position:` mismatch line from the guard's structural denotations, when both are present and differ. */
export function describeStructuralMismatch(
  expected: AdReplayTargetStructuralDenotation | undefined,
  observed: AdReplayTargetStructuralDenotation | undefined,
): string | undefined {
  if (!expected || !observed) return undefined;
  if (expected.documentOrder === observed.documentOrder && expected.sibling === observed.sibling) {
    return undefined;
  }
  return `position: recorded=doc${expected.documentOrder}/sibling${expected.sibling} observed=doc${observed.documentOrder}/sibling${observed.sibling}`;
}

/**
 * Dispatch resolution (with occlusion/visibility guards) resolved a
 * different element than pre-action verification isolated. `matchCount` is
 * the caller's already-known verified-member match count (verification's
 * own recorded-selector match count) — never re-derived from `evidence`.
 */
export function deriveReplayTargetGuardMismatchEvidence(
  recorded: TargetAnnotationV1,
  evidence: AdReplayGuardMismatchEvidence,
  matchCount: number,
): ReplayPostDispatchMismatchEvidence {
  const { observed, expectedStructural, observedStructural } = evidence;
  // The guard fires even when local identity is identical (a same-identity
  // duplicate resolved by structural position) — surface the structural
  // difference so `mismatches` is never empty on a real divergence.
  const structuralMismatch = describeStructuralMismatch(expectedStructural, observedStructural);
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
  evidence: AdReplayLandmarkMismatchEvidence,
): ReplayPostDispatchMismatchEvidence {
  const { matchCount, observed, observedAncestry } = evidence;
  return {
    matchCount,
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
