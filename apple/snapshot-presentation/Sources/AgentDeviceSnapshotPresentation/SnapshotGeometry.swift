import Foundation
import CoreGraphics

public enum SnapshotGeometry {
  /// The rect precondition of the shared `hittable` predicate and of anything that may serve as a
  /// viewport box, mirroring `isPositiveFiniteRect` in `packages/kernel/src/rect.ts`. Swift previously
  /// checked null/empty only, so two boxes the TypeScript side refuses were actionable here: a
  /// non-canonical box — a negative width, which the private AX bridge's JSON frame parser can hand
  /// over — and `CGRect.infinite`, whose center is (0,0) and therefore lands inside any viewport
  /// (#2891). `isInfinite` is checked apart from the components because `CGRect.infinite` is made of
  /// finite `Double`s (±DBL_MAX/2 and DBL_MAX); a box with actual infinite components is refused by
  /// the component checks instead.
  public static func isPositiveFinite(_ rect: CGRect) -> Bool {
    !rect.isInfinite
      && rect.origin.x.isFinite && rect.origin.y.isFinite
      && rect.size.width.isFinite && rect.size.height.isFinite
      && rect.size.width > 0 && rect.size.height > 0
  }

  /// Clipping asks one question and containment asks another, so they read the fact separately. Here:
  /// is there a box to clip against at all? A capture with no viewport cannot clip anything, which is
  /// not the same claim as "no node is inside it" — that second one is
  /// `isGeometricallyActionable`, and `SnapshotPresentationInvariant` relies on this pair by taking
  /// the same `rect` (no box means no cumulative clip to violate, not an unbounded clip).
  public static func effectiveFrame(
    reportedFrame: CGRect,
    viewport: SnapshotViewport,
    ancestorClip: CGRect?
  ) -> CGRect {
    var frame = reportedFrame
    if let box = viewport.rect {
      frame = clipped(frame, to: box)
    }
    if let ancestorClip {
      frame = clipped(frame, to: ancestorClip)
    }
    return frame
  }

  public static func snapshotRect(from frame: CGRect, reportedFrame: CGRect) -> SnapshotRect {
    guard !frame.isNull, !frame.isEmpty else {
      return SnapshotRect(
        x: Double(reportedFrame.minX),
        y: Double(reportedFrame.minY),
        width: 0,
        height: 0
      )
    }
    return SnapshotRect(
      x: Double(frame.origin.x),
      y: Double(frame.origin.y),
      width: Double(max(0, frame.size.width)),
      height: Double(max(0, frame.size.height))
    )
  }

  /// The one `hittable` predicate every iOS snapshot producer publishes (#1933), twin of
  /// `isGeometricallyActionable` in `packages/kernel/src/rect.ts`, including `CGRect.contains`'s
  /// half-open right and bottom edges: a center landing exactly on the viewport's right or bottom
  /// edge is not hittable on either producer. Both languages first refuse a node rect that is not
  /// positive and finite, so the precondition is one rule and not two (#2891).
  ///
  /// ## The unknown viewport — this site fails CLOSED
  ///
  /// `hittable` claims that a tap at the node's center lands. A capture with no viewport box cannot
  /// support that claim, so `.missing` publishes no actionability at all. That is the host's own
  /// direction with the instrument each side has: `resolveViewportEvidence` in
  /// `packages/capture-kit/src/ios-snapshot-engine/invariants.ts` refuses to fold a regular
  /// presentation without a positive finite viewport, so the TypeScript predicate is never reached
  /// with an unknown viewport — its `viewport` parameter is total by construction, which is why it
  /// has no case for the state. The runner's tree still presents: an empty interactive result is
  /// visible to the caller and the plan can still reach a tier that resolves a box, while an
  /// unsupported `true` is silent and would send a tap to a point nothing has located.
  ///
  /// A `.derived` box keeps answering containment. It is a screen box the capture read from its own
  /// root element, and `hittable` is load-bearing downstream (the #2638 wrapper verdict reads a
  /// declared `false` as evidence the wrapper is inert), so the fail-closed case stays exactly the
  /// one case with no box.
  public static func isGeometricallyActionable(
    enabled: Bool,
    frame: CGRect,
    viewport: SnapshotViewport
  ) -> Bool {
    guard enabled, isPositiveFinite(frame) else { return false }
    guard let box = viewport.rect else { return false }
    return box.contains(CGPoint(x: frame.midX, y: frame.midY))
  }

  private static func clipped(_ frame: CGRect, to clip: CGRect) -> CGRect {
    guard !frame.isNull, !frame.isEmpty else { return frame }
    let intersection = frame.intersection(clip)
    guard !intersection.isNull, !intersection.isEmpty else {
      return CGRect(x: frame.minX, y: frame.minY, width: 0, height: 0)
    }
    return intersection
  }
}
