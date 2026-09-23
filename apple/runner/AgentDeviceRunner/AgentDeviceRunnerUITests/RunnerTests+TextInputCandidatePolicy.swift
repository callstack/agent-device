import CoreGraphics
import XCTest

func isCoordinateTextInputCandidate(
  enabled: Bool,
  frame: CGRect,
  point: CGPoint,
  tolerance: CGFloat = 2
) -> Bool {
  enabled
    && !frame.isEmpty
    && point.x >= frame.minX - tolerance
    && point.x <= frame.maxX + tolerance
    && point.y >= frame.minY - tolerance
    && point.y <= frame.maxY + tolerance
}
