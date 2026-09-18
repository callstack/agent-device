import Foundation
import CoreGraphics

// Rotation between an app's interface space and the device's native (portrait-up) space, shared by
// synthesized dispatch (forward) and capture (inverse). Rationale and measurements: ADR 0004
// "the coordinate space of a captured subtree" and contracts/fixtures/window-coordinate-space.json.

public enum RunnerInterfaceOrientation {
  public static let unknown = 0
  public static let portrait = 1
  public static let portraitUpsideDown = 2
  public static let landscapeRight = 3
  public static let landscapeLeft = 4
}

public enum CoordinateSpaceRotation {
  public static func native(
    point: CGPoint,
    in frame: CGRect,
    interfaceOrientation: Int
  ) -> CGPoint {
    let localX = Double(point.x) - Double(frame.minX)
    let localY = Double(point.y) - Double(frame.minY)
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
    let localX: Double
    let localY: Double
    switch interfaceOrientation {
    case RunnerInterfaceOrientation.landscapeRight:
      localX = Double(point.y)
      localY = height - Double(point.x)
    case RunnerInterfaceOrientation.landscapeLeft:
      localX = width - Double(point.y)
      localY = Double(point.x)
    case RunnerInterfaceOrientation.portraitUpsideDown:
      localX = width - Double(point.x)
      localY = height - Double(point.y)
    default:
      localX = Double(point.x)
      localY = Double(point.y)
    }
    return CGPoint(x: localX + Double(frame.minX), y: localY + Double(frame.minY))
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

public enum SnapshotGeometrySpace: Equatable {
  case appOrientation
  case deviceNative(appFrame: CGRect, interfaceOrientation: Int)

  public static let quarterTurnTolerance: Double = 1

  public func orientedFrame(of reportedFrame: CGRect) -> CGRect {
    switch self {
    case .appOrientation:
      return reportedFrame
    case .deviceNative(let appFrame, let interfaceOrientation):
      return CoordinateSpaceRotation.oriented(
        rect: reportedFrame,
        in: appFrame,
        interfaceOrientation: interfaceOrientation
      )
    }
  }

  public static func space(
    reportedBySurfaceHost isSurfaceHost: Bool,
    reportedFrame: CGRect,
    inheritedFrom inherited: SnapshotGeometrySpace,
    appFrame: CGRect,
    interfaceOrientation: Int
  ) -> SnapshotGeometrySpace {
    guard isSurfaceHost else { return inherited }
    guard namesQuarterTurn(interfaceOrientation) else { return .appOrientation }
    guard isQuarterTurned(reportedFrame, relativeTo: appFrame) else { return .appOrientation }
    return .deviceNative(appFrame: appFrame, interfaceOrientation: interfaceOrientation)
  }

  public static func namesQuarterTurn(_ interfaceOrientation: Int) -> Bool {
    interfaceOrientation == RunnerInterfaceOrientation.landscapeLeft
      || interfaceOrientation == RunnerInterfaceOrientation.landscapeRight
  }

  public static func isSurfaceHost(isWindow: Bool, parentIsWindow: Bool) -> Bool {
    isWindow || parentIsWindow
  }

  private static func isQuarterTurned(_ frame: CGRect, relativeTo appFrame: CGRect) -> Bool {
    guard isPlottable(frame), isPlottable(appFrame),
      abs(appFrame.width - appFrame.height) > quarterTurnTolerance
    else {
      return false
    }
    return abs(frame.width - appFrame.height) <= quarterTurnTolerance
      && abs(frame.height - appFrame.width) <= quarterTurnTolerance
  }

  private static func isPlottable(_ frame: CGRect) -> Bool {
    frame.origin.x.isFinite && frame.origin.y.isFinite
      && frame.width.isFinite && frame.height.isFinite
      && frame.width > 0 && frame.height > 0
  }
}

extension SnapshotGeometrySpace {
  public static func normalized(
    nodes: [RawAXNode],
    viewport: CGRect,
    interfaceOrientation: Int
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
        appFrame: viewport,
        interfaceOrientation: interfaceOrientation
      )
      spaces[position] = nodeSpace
      let frame = nodeSpace.orientedFrame(of: node.rect.cgRect)
      result.append(
        node.replacing(
          rect: SnapshotRect(frame),
          hittable: node.parentIndex != nil
            && SnapshotGeometry.isGeometricallyActionable(
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
