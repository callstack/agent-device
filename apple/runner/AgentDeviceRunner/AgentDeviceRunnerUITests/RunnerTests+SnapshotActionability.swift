import Foundation

extension SnapshotGeometry {
  /// Geometric actionability shared by every iOS snapshot acquisition path. Native hit-testing
  /// and occlusion are separate facts owned by their respective layers.
  static func isGeometricallyActionable(
    enabled: Bool,
    frame: CGRect,
    viewport: CGRect
  ) -> Bool {
    guard enabled, !frame.isNull, !frame.isEmpty else { return false }
    if viewport.isInfinite { return true }
    let center = CGPoint(x: frame.midX, y: frame.midY)
    return viewport.contains(center)
  }
}
