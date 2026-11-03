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

public enum WindowContentSpace {}
public enum InterfaceScreenSpace {}
public enum NativeDigitizerSpace {}

public struct SurfacePoint<Space>: Equatable, Sendable {
  public let point: CGPoint
  public init(_ point: CGPoint) { self.point = point }
}

public struct SurfaceRect<Space>: Equatable, Sendable {
  public let rect: CGRect
  public init(_ rect: CGRect) { self.rect = rect }
}

/// Geometry measured once for a window. Panel size is absent when the runtime cannot prove it.
public struct SurfaceGeometry: Sendable {
  public let windowOnScreen: SurfaceRect<InterfaceScreenSpace>
  public let panelNativeSize: CGSize?
  public let orientation: Int

  public init(windowOnScreen: SurfaceRect<InterfaceScreenSpace>, panelNativeSize: CGSize?, orientation: Int) {
    self.windowOnScreen = windowOnScreen
    self.panelNativeSize = panelNativeSize
    self.orientation = orientation
  }

  public var digitizerBasis: SurfaceRect<InterfaceScreenSpace> {
    SurfaceRect(panelNativeSize.flatMap { Self.panelFrame(nativeSize: $0, orientation: orientation) }
      ?? windowOnScreen.rect)
  }

  public func screenPoint(from content: SurfacePoint<WindowContentSpace>) -> SurfacePoint<InterfaceScreenSpace> {
    let frame = windowOnScreen.rect
    let space = SnapshotGeometrySpace.windowContent(offset: CGSize(width: frame.minX, height: frame.minY))
    return SurfacePoint(space.orientedFrame(of: CGRect(origin: content.point, size: .zero)).origin)
  }

  public func contentPoint(from screen: SurfacePoint<InterfaceScreenSpace>) -> SurfacePoint<WindowContentSpace> {
    let origin = screenPoint(from: SurfacePoint(.zero)).point
    return SurfacePoint(CGPoint(x: screen.point.x - origin.x, y: screen.point.y - origin.y))
  }

  public func digitizerPoint(from screen: SurfacePoint<InterfaceScreenSpace>) -> SurfacePoint<NativeDigitizerSpace> {
    SurfacePoint(CoordinateSpaceRotation.native(
      point: screen.point, in: digitizerBasis.rect, interfaceOrientation: orientation))
  }

  public static func panelFrame(nativeSize size: CGSize, orientation: Int) -> CGRect? {
    guard size.width > 0, size.height > 0 else { return nil }
    switch orientation {
    case RunnerInterfaceOrientation.portrait, RunnerInterfaceOrientation.portraitUpsideDown:
      return CGRect(origin: .zero, size: size)
    case RunnerInterfaceOrientation.landscapeLeft, RunnerInterfaceOrientation.landscapeRight:
      return CGRect(x: 0, y: 0, width: size.height, height: size.width)
    default:
      return nil
    }
  }
}

public enum CoordinateSpaceRotation {
  // Dispatch turns a point's axes and never moves its origin: the digitizer's origin is the
  // display's own, where a placed window's screen points are already measured from (#3899).
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
    return CGPoint(x: localX, y: localY)
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

/// A placed iPad window reports its subtree from its own top-left (#3899, ADR 0004). Its carrier is a
/// `(0,0)`-anchored copy of a viewport box that starts elsewhere; the viewport origin is the offset.
public enum SnapshotContentTranslation {
  public static func offset(reportedBox: CGRect, viewportBox: CGRect) -> CGSize? {
    let tolerance = SnapshotGeometrySpace.quarterTurnTolerance
    func near(_ a: CGFloat, _ b: CGFloat) -> Bool { abs(a - b) <= tolerance }
    guard SnapshotGeometry.isPositiveFinite(reportedBox), SnapshotGeometry.isPositiveFinite(viewportBox),
      near(reportedBox.minX, 0), near(reportedBox.minY, 0),
      !near(viewportBox.minX, 0) || !near(viewportBox.minY, 0),
      near(reportedBox.width, viewportBox.width), near(reportedBox.height, viewportBox.height)
    else {
      return nil
    }
    return CGSize(width: viewportBox.minX, height: viewportBox.minY)
  }
}

public enum SnapshotGeometrySpace: Equatable {
  case appOrientation
  case deviceNative(appFrame: SnapshotViewport.Box, interfaceOrientation: Int)
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

  /// Only a `.reported` viewport is anchored on the screen, so only it can anchor a rotation or a
  /// translation.
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
    if namesQuarterTurn(interfaceOrientation), isQuarterTurned(reportedFrame, relativeTo: appFrame.rect) {
      return .deviceNative(appFrame: appFrame, interfaceOrientation: interfaceOrientation)
    }
    // A system window under a placed one (the keyboard, a SpringBoard overlay) reports the screen's
    // own box, so it names no offset and keeps its frames.
    return SnapshotContentTranslation.offset(reportedBox: reportedFrame, viewportBox: appFrame.rect)
      .map { .windowContent(offset: $0) } ?? .appOrientation
  }

  public static func namesQuarterTurn(_ interfaceOrientation: Int) -> Bool {
    interfaceOrientation == RunnerInterfaceOrientation.landscapeLeft
      || interfaceOrientation == RunnerInterfaceOrientation.landscapeRight
  }

  public static func isSurfaceHost(isWindow: Bool, parentIsWindow: Bool) -> Bool {
    isWindow || parentIsWindow
  }

  public static func space(
    reportedType: String,
    parentType: String?,
    reportedFrame: CGRect,
    inheritedFrom inherited: SnapshotGeometrySpace,
    viewport: SnapshotViewport
  ) -> SnapshotGeometrySpace {
    let carriers = SnapshotVisibilityFold.visibilityExemptCarrierTypes
    return space(
      reportedBySurfaceHost: isSurfaceHost(
        isWindow: carriers.contains(reportedType),
        parentIsWindow: parentType.map { carriers.contains($0) } ?? false
      ),
      reportedFrame: reportedFrame,
      inheritedFrom: inherited,
      viewport: viewport
    )
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
    var spaces = [SnapshotGeometrySpace](repeating: .appOrientation, count: nodes.count)
    var result: [RawAXNode] = []
    result.reserveCapacity(nodes.count)
    for (position, node) in nodes.enumerated() {
      let parentIndex = node.parentIndex.flatMap { $0 >= 0 && $0 < position ? $0 : nil }
      let nodeSpace = space(
        reportedType: node.type,
        parentType: parentIndex.map { nodes[$0].type },
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
