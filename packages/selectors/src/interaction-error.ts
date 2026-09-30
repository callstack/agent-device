/** Machine-readable `error.details.reason` values shared by interaction producers and adapters. */
export const INTERACTION_ERROR_REASONS = {
  selectorNotFound: 'selector_not_found',
  predicateFailed: 'predicate_failed',
  /**
   * An `@ref` names no node of the stored tree: stale, or never issued. `details.ref` carries the
   * bare ref body (`e12`), as `offscreen_ref` does. A consumer re-observes on this reason instead
   * of matching the message.
   */
  refNotFound: 'ref_not_found',
  /** An `@ref` names a listed node with no label to wait on or scope by; the tree is fresh. */
  refUnlabeled: 'ref_unlabeled',
  /** The target names a node with no usable centre to touch: a missing, non-finite, or negative rect. */
  targetBoundsInvalid: 'target_bounds_invalid',
  /**
   * A readiness poll captured a tree the snapshot-quality verdict calls sparse and the selector did
   * not resolve in it: the tree is untrustworthy, so absence proves nothing and the wait ends now.
   * `details.snapshotQuality` carries the verdict.
   */
  captureSparse: 'capture_sparse',
} as const;
