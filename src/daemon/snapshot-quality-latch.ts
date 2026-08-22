import type { SnapshotQualityVerdict } from '@agent-device/kernel/snapshot';
import { recoveredSnapshotQualityWarning } from '../snapshot-quality/warnings.ts';
import type { DaemonResponseData, SessionState } from './types.ts';

type RecoveredWarningLatch = NonNullable<SessionState['recoveredSnapshotWarningLatch']>;

type LatchDecision = {
  /** Full recovered warning to prepend to the response, when the latch was not held. */
  warning?: string;
  latch: RecoveredWarningLatch | undefined;
};

/**
 * One-shot warning latch for penalty-deferred captures (PR #1587 follow-up).
 *
 * `renderSnapshotQualityWarnings` suppresses the full recovered warning for
 * `reasonCode: 'deferred'` on the assumption that the capture which ARMED the
 * XCTest-channel penalty already rendered it. Internal captures (selector
 * resolution, settle observation loops, system-modal probes) can arm the
 * penalty without any user-facing render, and the runner cannot tell the two
 * apart — so the daemon tracks per session whether a recovered warning actually
 * reached this client for the currently penalized app, and re-renders it once
 * when it has not.
 *
 * Transitions (evaluated only on user-facing snapshot/diff responses):
 * - genuine `recovered` — the same response already carries the full warning
 *   (rendered by the runtime), so the latch is set without injecting anything;
 * - `deferred` with the latch not held for this app — inject the full warning
 *   once and set the latch;
 * - `healthy` — the penalty window is over; clear the latch so the next arming
 *   renders again;
 * - `sparse` or no verdict — no penalty signal either way; latch unchanged.
 *
 * The daemon cannot observe penalty arming directly (a 120s TTL held
 * runner-side), so "penalty window" is approximated by the verdicts of public
 * captures: as long as no public capture reports healthy, an unbroken hostile
 * stretch of the same app warns once.
 */
export function resolveRecoveredWarningLatch(params: {
  verdict: SnapshotQualityVerdict | undefined;
  appBundleId: string | undefined;
  latch: RecoveredWarningLatch | undefined;
}): LatchDecision {
  const { verdict, appBundleId, latch } = params;
  if (!verdict) return { latch };
  // Android helper quality is a platform-local verdict. It must not arm, clear, or otherwise
  // mutate the iOS XCTest penalty latch, which is session state for a different capture channel.
  if (verdict.backend === 'android-helper') return { latch };
  if (verdict.state === 'healthy') return { latch: undefined };
  if (verdict.state !== 'recovered') return { latch };
  // A request-pinned backend never degraded anything, so it neither warns nor
  // touches the penalty latch.
  if (verdict.reasonCode === 'requested-backend') return { latch };
  if (verdict.reasonCode !== 'deferred') {
    return { latch: { appBundleId } };
  }
  if (latch !== undefined && latch.appBundleId === appBundleId) return { latch };
  return { warning: recoveredSnapshotQualityWarning(verdict.backend), latch: { appBundleId } };
}

/**
 * The verdict slot the daemon snapshot backend fills on every capture, so the
 * latch seam sees the verdict of THE capture that produced this response.
 * Reading it back from `session.snapshot` instead would be wrong: an empty
 * ref-scoped capture deliberately retains the previous stored snapshot
 * (`shouldKeepCurrentSnapshot`), so a deferred capture could consult a retained
 * healthy verdict — clearing the latch and omitting the one-shot warning.
 */
export type CapturedSnapshotQuality = { value?: SnapshotQualityVerdict };

/**
 * Applies the latch to a user-facing snapshot/diff response: updates the
 * session's latch state and prepends the full recovered warning when this is
 * the penalty window's first user-facing render. Internal observation captures
 * (`req.internal.observationOnly`) must pass `internalObservation: true` — they
 * never reach the user, so they neither consume nor clear the latch.
 */
export function applyRecoveredWarningLatch(params: {
  session: SessionState | undefined;
  data: DaemonResponseData;
  /** The just-captured verdict (`CapturedSnapshotQuality`), never a stored one. */
  verdict: SnapshotQualityVerdict | undefined;
  internalObservation: boolean;
}): DaemonResponseData {
  const { session, data, verdict, internalObservation } = params;
  if (internalObservation || !session) return data;
  const decision = resolveRecoveredWarningLatch({
    verdict,
    appBundleId: session.appBundleId,
    latch: session.recoveredSnapshotWarningLatch,
  });
  session.recoveredSnapshotWarningLatch = decision.latch;
  if (!decision.warning) return data;
  const warnings = Array.isArray(data.warnings) ? data.warnings : [];
  return { ...data, warnings: [decision.warning, ...warnings] };
}
