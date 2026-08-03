import type { DaemonRequest, DaemonResponse } from '../types.ts';
import type {
  AdReplayDispatchGuard,
  AdReplayDispatchOutcome,
  AdReplayGuardMismatchEvidence,
  AdReplayLandmarkMismatchEvidence,
  AdReplayStepFailure,
} from '@agent-device/ad-replay';
import type { LocalIdentity } from '@agent-device/ad-script';
import type { TargetAncestryEntry } from '@agent-device/contracts/replay';
import {
  isReplayTargetGuardMismatchResponse,
  isWaitLandmarkMismatchResponse,
} from './session-replay-target-verification.ts';

/**
 * #1555 structural-quality review ("split step-loop.ts per the maestro
 * precedent it cites... shrink the runtime adapter toward the plan's <300
 * LOC metric"): extracted out of `session-replay-runtime-engine-adapter.ts`
 * — the cohesive "given a failed wire `DaemonResponse` and the pre-action
 * guard `dispatchStep` was threaded, decide whether it is an ordinary
 * failure or one of the two post-resolution identity-refusal markers, and
 * narrow the wire response's `details: Record<string, unknown> | undefined`
 * bag into the engine's typed evidence shapes" concern — separable from
 * `createAdReplayStepRuntime`'s runtime-bag construction itself. The
 * adapter's `dispatchStep` capability is this module's one caller.
 *
 * #1555 review P1 (second pass, "translate wire failures before the engine
 * boundary"): the wire response's `details` bag is read HERE, at the
 * daemon/wire boundary — the one place a real `DaemonResponse` exists — and
 * narrowed into the engine's typed evidence shapes before
 * `classifyReplayDispatchFailure` returns. `deriveReplayTargetGuardMismatchEvidence`/
 * `deriveWaitLandmarkMismatchEvidence` (`@agent-device/ad-replay`'s engine-
 * private `target-verification.ts`) consume only these typed values now —
 * the `unknown`-parsing readers below (reading `details.observed`/
 * `details.expectedStructural`/`details.observedStructural`/
 * `details.observedAncestry`/`details.matchCount` defensively) are
 * wire-reading responsibility, not engine policy.
 */

/** Threads a pre-action identity guard into the request's `internal` block the interaction layer reads for its own resolution — a no-op when no guard applies. */
export function applyReplayDispatchGuard(
  replayReq: DaemonRequest,
  guard: AdReplayDispatchGuard | undefined,
): DaemonRequest {
  const guardInternal =
    guard?.kind === 'target'
      ? { replayTargetGuard: guard.guard.expected }
      : guard?.kind === 'landmark'
        ? { replayLandmarkGuard: guard.landmark }
        : undefined;
  return guardInternal
    ? { ...replayReq, internal: { ...replayReq.internal, ...guardInternal } }
    : replayReq;
}

function readGuardMismatchObservedIdentity(value: unknown): LocalIdentity | undefined {
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
function readAncestryEntries(value: unknown): TargetAncestryEntry[] {
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

/** A structural denotation (`{documentOrder, sibling}`), defensively re-read off error details. */
function readTargetStructuralDenotation(
  value: unknown,
): { documentOrder: number; sibling: number } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.documentOrder !== 'number' || typeof record.sibling !== 'number') {
    return undefined;
  }
  return { documentOrder: record.documentOrder, sibling: record.sibling };
}

function readGuardMismatchEvidence(
  details: Record<string, unknown> | undefined,
): AdReplayGuardMismatchEvidence {
  return {
    observed: readGuardMismatchObservedIdentity(details?.observed),
    expectedStructural: readTargetStructuralDenotation(details?.expectedStructural),
    observedStructural: readTargetStructuralDenotation(details?.observedStructural),
  };
}

function readLandmarkMismatchEvidence(
  details: Record<string, unknown> | undefined,
): AdReplayLandmarkMismatchEvidence {
  return {
    matchCount: typeof details?.matchCount === 'number' ? details.matchCount : undefined,
    observed: readGuardMismatchObservedIdentity(details?.observed),
    observedAncestry: readAncestryEntries(details?.observedAncestry),
  };
}

/** Projects a wire response down to the neutral shape the engine's outcome carries. */
export function toAdReplayStepFailure(
  response: Extract<DaemonResponse, { ok: false }>,
  artifactPaths: readonly string[],
): AdReplayStepFailure {
  return { kind: response.error.code, message: response.error.message, artifactPaths };
}

/** Classifies a failed dispatch response into an ordinary failure or one of the two post-resolution identity-refusal markers (`guard-mismatch`/`landmark-mismatch`) `dispatchStep` detects. */
export function classifyReplayDispatchFailure(
  response: Extract<DaemonResponse, { ok: false }>,
  guard: AdReplayDispatchGuard | undefined,
  entries: readonly string[],
): AdReplayDispatchOutcome {
  const plainFailure = toAdReplayStepFailure(response, entries);
  if (guard?.kind === 'target' && isReplayTargetGuardMismatchResponse(response)) {
    return {
      status: 'guard-mismatch',
      evidence: readGuardMismatchEvidence(response.error.details),
      plainFailure,
      artifactPaths: entries,
    };
  }
  if (guard?.kind === 'landmark' && isWaitLandmarkMismatchResponse(response)) {
    return {
      status: 'landmark-mismatch',
      evidence: readLandmarkMismatchEvidence(response.error.details),
      plainFailure,
      artifactPaths: entries,
    };
  }
  return { status: 'failed', failure: plainFailure };
}
