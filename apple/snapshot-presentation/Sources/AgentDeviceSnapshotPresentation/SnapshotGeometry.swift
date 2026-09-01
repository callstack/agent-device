import Foundation
import CoreGraphics

public enum SnapshotGeometry {
  public static func effectiveFrame(
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

  public static func isGeometricallyActionable(
    enabled: Bool,
    frame: CGRect,
    viewport: CGRect
  ) -> Bool {
    guard enabled, !frame.isNull, !frame.isEmpty else { return false }
    if viewport.isInfinite { return true }
    let center = CGPoint(x: frame.midX, y: frame.midY)
    return viewport.contains(center)
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
