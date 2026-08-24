import type { SnapshotState } from '@agent-device/kernel/snapshot';

/**
 * What a navigation-sensitive action recorded about the tree it was dispatched against, so a
 * later capture can be judged against it.
 *
 * The window carries no platform vocabulary: it is a marked instant, a baseline size, and an
 * optional route signature. Which shapes count as suspicious is decided by the `classify`
 * callback the recovery loop is bound with, not by the window, so a second backend with an async
 * hierarchy dump can reuse the window and the loop without inheriting Android's thresholds.
 */
export type SnapshotFreshnessWindow = {
  action: string;
  markedAt: number;
  baselineCount: number;
  baselineSignatures?: string[];
  routeComparable: boolean;
};

/** Which staleness shape a capture matched, or `null` when the capture looked trustworthy. */
export type SnapshotFreshnessReason = 'empty-interactive' | 'sharp-drop' | 'stuck-route';

/**
 * `ref-refresh` re-reads a known tree to refresh refs rather than to observe a transition, so it
 * opts out of the route-comparison shapes while keeping the empty-interactive guard.
 */
export type SnapshotFreshnessMode = 'default' | 'ref-refresh';

/**
 * One capture judged against a window. `rawNodeCount` is the acquisition backend's pre-filter
 * node count when it disclosed one — absent means the backend proved nothing about how much it
 * filtered away.
 */
export type SnapshotFreshnessAttempt = {
  snapshot: SnapshotState;
  rawNodeCount: number | undefined;
};
