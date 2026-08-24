/**
 * Which execution tier one gesture input needs. The tier comes from the input alone — never from
 * the device — because a tier's *availability* is what varies by owner, and mixing the two is how
 * the retired `requireGestureSupported` ended up owning a platform table inside the daemon.
 *
 * Type-only on purpose: the classifier that produces it lives beside the use catalog that consumes
 * it, so naming a tier costs an importer no eager module evaluation.
 */
export type GestureRuntimeTier =
  | 'plan'
  | 'directional-fling'
  | 'multi-touch'
  | 'target-authored-drag';
