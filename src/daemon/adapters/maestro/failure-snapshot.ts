import { collectMaestroFailureSuggestions, type MaestroFailedAction } from '@agent-device/maestro';
import type { SnapshotState } from '@agent-device/kernel/snapshot';

/**
 * Adapts package-owned target semantics to daemon divergence suggestions.
 * Ranking remains inside the Maestro module; the daemon sees only ranked values.
 */
export function adaptMaestroFailureSnapshot(failure: MaestroFailedAction, snapshot: SnapshotState) {
  return collectMaestroFailureSuggestions(failure, snapshot);
}
