import Foundation
import CoreGraphics

public enum SnapshotGeometry {
  /// Twin of `isPositiveFiniteRect` in `packages/kernel/src/rect.ts`. `CGRect.infinite` is built
  /// from finite components, so it is refused by identity.
  public static func isPositiveFinite(_ rect: CGRect) -> Bool {
    !rect.isInfinite
      && rect.origin.x.isFinite && rect.origin.y.isFinite
      && rect.size.width.isFinite && rect.size.height.isFinite
      && rect.size.width > 0 && rect.size.height > 0
  }

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

  /// The shared `hittable` predicate (#1933), twin of `isGeometricallyActionable` in
  /// `packages/kernel/src/rect.ts`, with `CGRect.contains`'s half-open right and bottom edges.
  /// `nil` when only containment is left to decide and the capture has no viewport box: the node's
  /// `hittable` is then absent on the wire, as it is on the host bridge (#2891).
  public static func isGeometricallyActionable(
    enabled: Bool,
    frame: CGRect,
    viewport: SnapshotViewport
  ) -> Bool? {
    guard enabled, isPositiveFinite(frame) else { return false }
    guard let box = viewport.rect else { return nil }
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
