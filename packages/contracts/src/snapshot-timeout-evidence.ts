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

export type SnapshotTimeoutEvidence =
  | {
      captureFailed: true;
      error: string;
    }
  | (CapturedSnapshotTimeoutEvidenceBase & {
      overlayRefSource: 'unavailable';
      overlayRefsAnnotated: false;
      overlayRefCount: 0;
    })
  | (CapturedSnapshotTimeoutEvidenceBase & {
      overlayRefSource: 'session-snapshot';
      overlayRefsAnnotated: true;
      overlayRefCount: number;
      overlayRefs: NonEmptyScreenshotOverlayRefs;
    })
  | (CapturedSnapshotTimeoutEvidenceBase & {
      overlayRefSource: 'session-snapshot';
      overlayRefsAnnotated: false;
      overlayRefCount: 0;
      overlayRefs: readonly [];
    })
  | (CapturedSnapshotTimeoutEvidenceBase & {
      overlayRefSource: 'session-snapshot';
      overlayRefsAnnotated: false;
      overlayRefCount: 0;
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
    overlayRefCount: 0,
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
    ? {
        ...base,
        overlayRefsAnnotated: true,
        overlayRefCount: overlayRefs.length,
        overlayRefs,
      }
    : {
        ...base,
        overlayRefsAnnotated: false,
        overlayRefCount: 0,
        overlayRefs: [],
      };
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
    overlayRefCount: 0,
    overlayAnnotationError,
  };
}

/**
 * The overlay counts a diagnostic may report, narrowed off the union so a log site does not
 * re-derive the arm discrimination with `in` checks.
 */
export function snapshotTimeoutEvidenceOverlayCounts(evidence: SnapshotTimeoutEvidence): {
  overlayRefCount: number | undefined;
  overlayRefsAnnotated: boolean | undefined;
} {
  return 'captureFailed' in evidence
    ? { overlayRefCount: undefined, overlayRefsAnnotated: undefined }
    : {
        overlayRefCount: evidence.overlayRefCount,
        overlayRefsAnnotated: evidence.overlayRefsAnnotated,
      };
}
