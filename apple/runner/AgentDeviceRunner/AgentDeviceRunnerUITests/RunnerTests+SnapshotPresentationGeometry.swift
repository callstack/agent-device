import Foundation

/// The typed carrier between acquisition facts and snapshot wire projection.
///
/// `raw.rect` remains the backend-reported frame for runner-internal traversal and deduplication.
/// `effectiveRect` is the geometry after the regular presentation policy. Raw projection sets both
/// to the reported frame, so callers cannot accidentally publish an unclassified geometry source.
struct SnapshotPresentationNode {
  let raw: RawAXNode
  let effectiveRect: SnapshotRect

  init(raw: RawAXNode, effectiveRect: SnapshotRect) {
    self.raw = raw
    self.effectiveRect = effectiveRect
  }

  static func reported(_ raw: RawAXNode) -> Self {
    Self(raw: raw, effectiveRect: raw.rect)
  }
}

/// Geometry conversion owned by presentation. Acquisition reports frames; this type computes the
/// only rectangle that can cross the regular snapshot wire boundary.
enum SnapshotGeometry {
  static func effectiveFrame(
    reportedFrame: CGRect,
    viewport: CGRect,
    ancestorClip: CGRect?
  ) -> CGRect {
    var frame = reportedFrame
    if !viewport.isInfinite {
      frame = clipped(frame, to: viewport)
    }
    if let ancestorClip {
      frame = clipped(frame, to: ancestorClip)
    }
    return frame
  }

  static func snapshotRect(from frame: CGRect, reportedFrame: CGRect) -> SnapshotRect {
    guard !frame.isNull, !frame.isEmpty else {
      return SnapshotRect(
        x: Double(reportedFrame.minX), y: Double(reportedFrame.minY), width: 0, height: 0)
    }
    return SnapshotRect(
      x: Double(frame.origin.x),
      y: Double(frame.origin.y),
      width: Double(max(0, frame.size.width)),
      height: Double(max(0, frame.size.height))
    )
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
