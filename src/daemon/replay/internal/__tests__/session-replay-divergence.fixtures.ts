import { vi } from 'vitest';

// Every divergence sibling drives the same two seams: device resolution is
// stubbed so no real device is probed, and the snapshot interactor is stubbed so
// the capture step is fed from the shared `legacyDispatchCapture` double instead
// of the (slow/hanging) real runner. Declared once here — the module every
// `session-replay-divergence-*.test.ts` sibling imports — so the split does not
// copy the pair per file. The Android freshness-retry `sleep` stub is NOT here:
// only the two siblings that exercise a retry branch need it, and they declare it
// themselves so it cannot silently no-op the retry delay in the other siblings.
vi.mock('@agent-device/device-selection/dispatch-resolve', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, resolveTargetDevice: vi.fn() };
});
vi.mock('../../../snapshot-interactor-capture.ts', () => ({
  captureSnapshotWithInteractor: vi.fn(),
}));

// The two seams above only intercept imports made inside THIS module's graph, so the
// divergence SUTs are imported here — below the `vi.mock` calls — and handed back to
// the siblings through the frozen object below. Importing them directly from a sibling
// would resolve the real snapshot interactor and hang on the (unmocked) runner dispatch.
import {
  buildReplayFailureDivergence,
  captureDivergenceObservation,
} from '../session-replay-divergence.ts';
import { captureSnapshotWithInteractor } from '../../../snapshot-interactor-capture.ts';
import {
  legacyDispatchCapture,
  resetLegacySnapshotCapture,
} from '../../../__tests__/legacy-snapshot-capture-fixture.ts';

/**
 * One reset for the whole divergence family: clears the capture double and
 * re-points the mocked interactor at it. Every sibling wires this as its
 * `beforeEach` (via `divergenceFixture` below); it is the seam's own mechanics,
 * not per-suite policy.
 */
function resetDivergenceCapture(): void {
  resetLegacySnapshotCapture(vi.mocked(captureSnapshotWithInteractor));
}

/**
 * The mock instances and SUTs the siblings share. They ride one explicit object
 * (rather than a re-export list through the hoisted transform) so every sibling
 * operates on the same `mockDispatchCommand` double the reset clears, and reads the
 * interactor-mocked SUTs loaded above.
 */
export const divergenceFixture = Object.freeze({
  buildReplayFailureDivergence,
  captureDivergenceObservation,
  mockDispatchCommand: legacyDispatchCapture,
  resetDivergenceCapture,
});
