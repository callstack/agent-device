import CoreGraphics
import Foundation
import AgentDeviceSnapshotPresentation

struct RunnerKeyboardStatus: Equatable {
  let visible: Bool
  let returnKey: String?
  let returnKeyLabel: String?

  static let hidden = RunnerKeyboardStatus(visible: false, returnKey: nil, returnKeyLabel: nil)
  private static let visibleWithUnknownReturn = RunnerKeyboardStatus(visible: true, returnKey: "unknown", returnKeyLabel: nil)

  struct ObservedKeyboardKey {
    let label: String
    let identifier: String
    let frame: CGRect
    let isKey: Bool
  }

  /// An iPad accessory can appear as the keyboard while its keys sit below the display.
  static func observed(
    keyboardFrame: CGRect,
    keys: [ObservedKeyboardKey],
    nativeDisplaySize: CGSize?,
    interfaceOrientation: Int
  ) -> RunnerKeyboardStatus? {
    guard SnapshotGeometry.isPositiveFinite(keyboardFrame),
      let nativeDisplaySize,
      let frame = SurfaceGeometry.panelFrame(nativeSize: nativeDisplaySize, orientation: interfaceOrientation),
      case .reported(let bounds, _) = SnapshotViewport.reported(box: frame)
    else { return nil }
    let space = keyboardSpace(keyboardFrame, displayBounds: bounds, interfaceOrientation: interfaceOrientation)
    let visibleFrame = space.orientedFrame(of: keyboardFrame).intersection(bounds.rect)
    guard SnapshotGeometry.isPositiveFinite(visibleFrame) else { return .hidden }

    let measuredKeys = keys.compactMap { key -> ObservedKeyboardKey? in
      guard SnapshotGeometry.isPositiveFinite(key.frame) else { return nil }
      return ObservedKeyboardKey(label: key.label, identifier: key.identifier, frame: space.orientedFrame(of: key.frame), isKey: key.isKey)
    }
    let visibleKeys = measuredKeys.filter { visibleFrame.contains(CGPoint(x: $0.frame.midX, y: $0.frame.midY)) }
    guard let firstKeyY = visibleKeys.filter(\.isKey).map(\.frame.minY).min() else {
      return measuredKeys.contains(where: \.isKey) ? .hidden : .visibleWithUnknownReturn
    }

    let returnKeys = visibleKeys.compactMap { key -> (RunnerKeyboardReturnKey, String)? in
      let kind = RunnerKeyboardReturnKey.kind(forIdentifier: key.identifier)
      guard kind != .unknown, key.frame.maxY > firstKeyY else { return nil }
      return (kind, key.label.trimmingCharacters(in: .whitespacesAndNewlines))
    }
    guard returnKeys.count == 1, let (kind, label) = returnKeys.first else {
      return .visibleWithUnknownReturn
    }
    return RunnerKeyboardStatus(visible: true, returnKey: kind.rawValue, returnKeyLabel: label.isEmpty ? nil : label)
  }

  /// A landscape iPhone can report a vertical key plane in portrait display coordinates.
  private static func keyboardSpace(
    _ frame: CGRect, displayBounds: SnapshotViewport.Box, interfaceOrientation: Int
  ) -> SnapshotGeometrySpace {
    let bounds = displayBounds.rect
    guard SnapshotGeometrySpace.namesQuarterTurn(interfaceOrientation),
      bounds.width > bounds.height,
      frame.height > frame.width, !bounds.contains(frame),
      CGRect(x: 0, y: 0, width: bounds.height, height: bounds.width).contains(frame)
    else { return .appOrientation }
    return .deviceNative(appFrame: displayBounds, interfaceOrientation: interfaceOrientation)
  }
}
