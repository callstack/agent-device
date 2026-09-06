import type { ScreenshotOverlayRef } from '@agent-device/kernel/snapshot';

/**
 * The typed `details.androidSnapshotTimeoutScreenshot` payload published when an accessibility
 * snapshot times out and the daemon falls back to a screenshot (#1983).
 *
 * The shape is a discriminated union rather than a bag of optional fields because each arm is a
 * different claim about what evidence exists: no capture at all, a capture with no snapshot to
 * annotate from, a capture annotated with overlay refs, or a capture whose annotation failed.
 * Callers construct it through the builders below so an assembly site cannot publish a fifth,
 * undeclared arm.
 */
type CapturedSnapshotTimeoutEvidenceBase = {
  path: string;
  overlayRefsRequested: true;
};

/** At least one ref. Annotation is a claim that something was drawn, so it cannot be empty. */
export type NonEmptyScreenshotOverlayRefs = readonly [
  ScreenshotOverlayRef,
  ...ScreenshotOverlayRef[],
];

/**
 * No arm stores a ref count. A count beside the refs is a second source of truth that the type
 * system cannot keep in step — `{annotated: true, count: 0, refs: [ref]}` would stay assignable —
 * so the count is derived from `overlayRefs` by `snapshotTimeoutEvidenceOverlayCounts` instead.
 * The arms that carry no refs have nothing to count, which `overlayRefsAnnotated: false` already
 * states.
 */
export type SnapshotTimeoutEvidence =
  | {
      captureFailed: true;
      error: string;
    }
  | (CapturedSnapshotTimeoutEvidenceBase & {
      overlayRefSource: 'unavailable';
      overlayRefsAnnotated: false;
    })
  | (CapturedSnapshotTimeoutEvidenceBase & {
      overlayRefSource: 'session-snapshot';
      overlayRefsAnnotated: true;
      overlayRefs: NonEmptyScreenshotOverlayRefs;
    })
  | (CapturedSnapshotTimeoutEvidenceBase & {
      overlayRefSource: 'session-snapshot';
      overlayRefsAnnotated: false;
      overlayRefs: readonly [];
    })
  | (CapturedSnapshotTimeoutEvidenceBase & {
      overlayRefSource: 'session-snapshot';
      overlayRefsAnnotated: false;
      overlayAnnotationError: string;
    });

/** No screenshot was taken: the evidence path itself failed. */
export function snapshotTimeoutCaptureFailed(error: string): SnapshotTimeoutEvidence {
  return { captureFailed: true, error };
}

/** A screenshot exists, but no stored observation was available to derive overlay refs from. */
export function snapshotTimeoutEvidenceWithoutOverlaySource(path: string): SnapshotTimeoutEvidence {
  return {
    path,
    overlayRefsRequested: true,
    overlayRefsAnnotated: false,
    overlayRefSource: 'unavailable',
  };
}

/**
 * A screenshot annotated from the stored observation. An empty ref list is not an annotation, and
 * the union says so: the annotated arm carries a non-empty tuple, so `annotated: true` with zero
 * refs is not a state a caller can build or a reader has to defend against.
 */
export function snapshotTimeoutEvidenceWithOverlayRefs(
  path: string,
  overlayRefs: readonly ScreenshotOverlayRef[],
): SnapshotTimeoutEvidence {
  const base = { path, overlayRefsRequested: true, overlayRefSource: 'session-snapshot' } as const;
  return isNonEmptyOverlayRefs(overlayRefs)
    ? { ...base, overlayRefsAnnotated: true, overlayRefs }
    : { ...base, overlayRefsAnnotated: false, overlayRefs: [] };
}

function isNonEmptyOverlayRefs(
  refs: readonly ScreenshotOverlayRef[],
): refs is NonEmptyScreenshotOverlayRefs {
  return refs.length > 0;
}

/** A screenshot exists and a stored observation existed, but annotating it threw. */
export function snapshotTimeoutEvidenceOverlayFailed(
  path: string,
  overlayAnnotationError: string,
): SnapshotTimeoutEvidence {
  return {
    path,
    overlayRefsRequested: true,
    overlayRefsAnnotated: false,
    overlayRefSource: 'session-snapshot',
    overlayAnnotationError,
  };
}

/**
 * The overlay counts a diagnostic may report, derived from the refs the evidence actually holds.
 * This is the only place a count exists, so it cannot disagree with the arm it came from.
 */
export function snapshotTimeoutEvidenceOverlayCounts(evidence: SnapshotTimeoutEvidence): {
  overlayRefCount: number | undefined;
  overlayRefsAnnotated: boolean | undefined;
} {
  if ('captureFailed' in evidence) {
    return { overlayRefCount: undefined, overlayRefsAnnotated: undefined };
  }
  return {
    overlayRefCount: 'overlayRefs' in evidence ? evidence.overlayRefs.length : 0,
    overlayRefsAnnotated: evidence.overlayRefsAnnotated,
  };
}
