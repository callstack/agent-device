import Foundation
import CoreGraphics

// Rotation between an app's interface space and the device's native (portrait-up) space, shared by
// synthesized dispatch (forward) and capture (inverse). Rationale and measurements: ADR 0004
// "the coordinate space of a captured subtree" and contracts/fixtures/window-coordinate-space.json.
//
// Rotation moves axes only. It never moves an origin: a placed window's offset from the screen
// belongs to `SnapshotContentTranslation` (#3899), which is the one rule that turns a reported box
// into its screen-space box. Keeping the two apart is what lets a capture publish one space.

public enum RunnerInterfaceOrientation {
  public static let unknown = 0
  public static let portrait = 1
  public static let portraitUpsideDown = 2
  public static let landscapeRight = 3
  public static let landscapeLeft = 4
}

public enum CoordinateSpaceRotation {
  // Dispatch turns a point's axes and never moves its origin: the turn says which axis a box runs
  // along, not where that box sits (#3899). The digitizer's origin is the display's own, which is
  // where a windowed app's screen-space points are already measured from, so a placed window's
  // offset from the screen belongs to `SnapshotContentTranslation` — the one rule that reads an
  // offset — and not to this function. The `frame` argument names the side lengths the turn swaps.
  public static func native(
    point: CGPoint,
    in frame: CGRect,
    interfaceOrientation: Int
  ) -> CGPoint {
    let localX = Double(point.x)
    let localY = Double(point.y)
    let width = Double(frame.width)
    let height = Double(frame.height)
    switch interfaceOrientation {
    case RunnerInterfaceOrientation.landscapeRight:
      return CGPoint(x: height - localY, y: localX)
    case RunnerInterfaceOrientation.landscapeLeft:
      return CGPoint(x: localY, y: width - localX)
    case RunnerInterfaceOrientation.portraitUpsideDown:
      return CGPoint(x: width - localX, y: height - localY)
    default:
      return CGPoint(x: localX, y: localY)
    }
  }

  public static func native(vector: CGVector, interfaceOrientation: Int) -> CGVector {
    switch interfaceOrientation {
    case RunnerInterfaceOrientation.landscapeRight:
      return CGVector(dx: -vector.dy, dy: vector.dx)
    case RunnerInterfaceOrientation.landscapeLeft:
      return CGVector(dx: vector.dy, dy: -vector.dx)
    case RunnerInterfaceOrientation.portraitUpsideDown:
      return CGVector(dx: -vector.dx, dy: -vector.dy)
    default:
      return vector
    }
  }

  public static func oriented(
    point: CGPoint,
    in frame: CGRect,
    interfaceOrientation: Int
  ) -> CGPoint {
    let width = Double(frame.width)
    let height = Double(frame.height)
    let x: Double
    let y: Double
    switch interfaceOrientation {
    case RunnerInterfaceOrientation.landscapeRight:
      x = Double(point.y)
      y = height - Double(point.x)
    case RunnerInterfaceOrientation.landscapeLeft:
      x = width - Double(point.y)
      y = Double(point.x)
    case RunnerInterfaceOrientation.portraitUpsideDown:
      x = width - Double(point.x)
      y = height - Double(point.y)
    default:
      x = Double(point.x)
      y = Double(point.y)
    }
    return CGPoint(x: x, y: y)
  }

  public static func oriented(
    rect: CGRect,
    in frame: CGRect,
    interfaceOrientation: Int
  ) -> CGRect {
    let leading = oriented(
      point: CGPoint(x: rect.minX, y: rect.minY),
      in: frame,
      interfaceOrientation: interfaceOrientation
    )
    let trailing = oriented(
      point: CGPoint(x: rect.maxX, y: rect.maxY),
      in: frame,
      interfaceOrientation: interfaceOrientation
    )
    return CGRect(
      x: min(leading.x, trailing.x),
      y: min(leading.y, trailing.y),
      width: abs(trailing.x - leading.x),
      height: abs(trailing.y - leading.y)
    )
  }
}

/// Whether a carrier's own box declares that its subtree reports in the carrier's content space
/// rather than in the space the viewport names (#3899).
///
/// An iPad window that does not fill the screen (Windowed Apps, Stage Manager) reports its own frame
/// at its place on the screen while its subtree arrives anchored at its own top-left: measured on
/// iPad Pro 11-inch (M5, iOS 27.0) with a Calendar window whose `frame` is `(224,207,386,682)`, the
/// application root reports `(0,0,386,682)` and its Add button `(335,14,37,36)` at screen
/// `(559,221)`. A full-screen window, an iPhone, and each foldable panel report origins at zero on
/// both sides, so the rule reads zero translation there and every published rect is unchanged.
///
/// The signature is the carrier's box as a `(0,0)`-anchored copy of the viewport box: the side
/// lengths match within the tolerance and the viewport — the app's screen-anchored box — starts
/// somewhere else on the screen. Any other carrier box names no space: it is not the app's own
/// window, so its numbers say nothing about where the app's subtree starts.
public enum SnapshotContentTranslation {
  /// The vector from a carrier's reported box to the screen space it is placed at, or `nil` when the
  /// carrier's box declares no translation. One box offset from one viewport box, decided from the
  /// same tolerance the quarter-turn rule reads; replayed against
  /// `contracts/fixtures/window-coordinate-space.json` in `windowContentCases`.
  public static func offset(reportedBox: CGRect, viewportBox: CGRect) -> CGSize? {
    guard SnapshotGeometry.isPositiveFinite(reportedBox),
      SnapshotGeometry.isPositiveFinite(viewportBox)
    else {
      return nil
    }
    guard abs(reportedBox.minX) <= SnapshotGeometrySpace.quarterTurnTolerance,
      abs(reportedBox.minY) <= SnapshotGeometrySpace.quarterTurnTolerance
    else {
      return nil
    }
    guard abs(viewportBox.minX) > SnapshotGeometrySpace.quarterTurnTolerance
      || abs(viewportBox.minY) > SnapshotGeometrySpace.quarterTurnTolerance
    else {
      return nil
    }
    guard abs(reportedBox.width - viewportBox.width) <= SnapshotGeometrySpace.quarterTurnTolerance,
      abs(reportedBox.height - viewportBox.height) <= SnapshotGeometrySpace.quarterTurnTolerance
    else {
      return nil
    }
    return CGSize(width: viewportBox.minX, height: viewportBox.minY)
  }
}

public enum SnapshotGeometrySpace: Equatable {
  case appOrientation
  case deviceNative(appFrame: SnapshotViewport.Box, interfaceOrientation: Int)
  /// The subtree was reported in a placed window's own content space and is published translated
  /// into the viewport's screen space (`SnapshotContentTranslation`, #3899). The offset is the
  /// vector from the window's reported box to the viewport box it sits at on screen.
  case windowContent(offset: CGSize)

  public static let quarterTurnTolerance: Double = 1

  public func orientedFrame(of reportedFrame: CGRect) -> CGRect {
    switch self {
    case .appOrientation:
      return reportedFrame
    case .deviceNative(let appFrame, let interfaceOrientation):
      return CoordinateSpaceRotation.oriented(
        rect: reportedFrame,
        in: appFrame.rect,
        interfaceOrientation: interfaceOrientation
      )
    case .windowContent(let offset):
      return reportedFrame.offsetBy(dx: offset.width, dy: offset.height)
    }
  }

  /// A carrier declares its own subtree's space from its own box. A `.reported` viewport is the
  /// screen-anchored fact both declarations read against: a quarter turn needs its orientation, and
  /// a window-content offset needs its origin. A `.derived` viewport carries no screen anchor, so a
  /// subtree under it publishes what the platform reported rather than a guessed space.
  public static func space(
    reportedBySurfaceHost isSurfaceHost: Bool,
    reportedFrame: CGRect,
    inheritedFrom inherited: SnapshotGeometrySpace,
    viewport: SnapshotViewport
  ) -> SnapshotGeometrySpace {
    guard isSurfaceHost else { return inherited }
    guard case .reported(let appFrame, let interfaceOrientation) = viewport else {
      return .appOrientation
    }
    if namesQuarterTurn(interfaceOrientation),
      isQuarterTurned(reportedFrame, relativeTo: appFrame.rect) {
      return .deviceNative(appFrame: appFrame, interfaceOrientation: interfaceOrientation)
    }
    if let offset = SnapshotContentTranslation.offset(
      reportedBox: reportedFrame,
      viewportBox: appFrame.rect
    ) {
      return .windowContent(offset: offset)
    }
    return .appOrientation
  }

  public static func namesQuarterTurn(_ interfaceOrientation: Int) -> Bool {
    interfaceOrientation == RunnerInterfaceOrientation.landscapeLeft
      || interfaceOrientation == RunnerInterfaceOrientation.landscapeRight
  }

  public static func isSurfaceHost(isWindow: Bool, parentIsWindow: Bool) -> Bool {
    isWindow || parentIsWindow
  }

  private static func isQuarterTurned(_ frame: CGRect, relativeTo appFrame: CGRect) -> Bool {
    guard SnapshotGeometry.isPositiveFinite(frame),
      abs(appFrame.width - appFrame.height) > quarterTurnTolerance
    else {
      return false
    }
    return abs(frame.width - appFrame.height) <= quarterTurnTolerance
      && abs(frame.height - appFrame.width) <= quarterTurnTolerance
  }
}

extension SnapshotGeometrySpace {
  public static func normalized(
    nodes: [RawAXNode],
    viewport: SnapshotViewport
  ) -> [RawAXNode] {
    let carriers = SnapshotVisibilityFold.visibilityExemptCarrierTypes
    var spaces = [SnapshotGeometrySpace](repeating: .appOrientation, count: nodes.count)
    var result: [RawAXNode] = []
    result.reserveCapacity(nodes.count)
    for (position, node) in nodes.enumerated() {
      let parentIndex = node.parentIndex.flatMap { $0 >= 0 && $0 < position ? $0 : nil }
      let nodeSpace = space(
        reportedBySurfaceHost: isSurfaceHost(
          isWindow: carriers.contains(node.type),
          parentIsWindow: parentIndex.map { carriers.contains(nodes[$0].type) } ?? false
        ),
        reportedFrame: node.rect.cgRect,
        inheritedFrom: parentIndex.map { spaces[$0] } ?? .appOrientation,
        viewport: viewport
      )
      spaces[position] = nodeSpace
      let frame = nodeSpace.orientedFrame(of: node.rect.cgRect)
      result.append(
        node.replacing(
          rect: SnapshotRect(frame),
          hittable: node.parentIndex == nil
            ? false
            : SnapshotGeometry.isGeometricallyActionable(
              enabled: node.enabled,
              frame: frame,
              viewport: viewport
            )
        )
      )
    }
    return result
  }
}
