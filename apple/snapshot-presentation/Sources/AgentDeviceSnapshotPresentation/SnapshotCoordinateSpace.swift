import Foundation
import CoreGraphics

// Where a piece of geometry lives, and how it gets where the caller means it.
//
// DISPATCH: synthesized events skip XCTest's orientation handling, so a point planned in an app's
// interface space has to be rotated into the device's native (portrait-up) space before it is
// performed. Without that, a landscape tap lands somewhere else.
//
// CAPTURE: iOS hosts some system surfaces in that native space even while the app is rotated, so
// their whole subtree arrives quarter-turned. Measured on iPhone 17 Pro (iOS 26.2) with the system
// keyboard up in landscape: the app viewport is 874 x 402, `UIRemoteKeyboardWindow` reports its own
// box as 402 x 874, a key arrives 45 x 72 at x 154, and the key plane as 202 x 724 — a strip down
// the left edge — while the screenshot draws a 724 x 204 band docked at y 198, which is exactly
// what the live `app.keyboards` query measures. Rules that read the reported numbers refused app
// content the keyboard was nowhere near and let a tap through into a key (#2612, #2589).
//
// Both directions live in ONE table on purpose: capture rotates back with the exact inverse of what
// dispatch rotates forward, so a performed tap and a reported rect can never disagree about which
// pixel is which. The round-trip test in the package suite is that proof, not a comment asking for
// care. This file is pure geometry, which is why it lives here rather than in the XCTest bundle:
// nothing in it needs a simulator to run.

/// The UIInterfaceOrientation raw values the rotation table switches on. XCTest exposes the app's
/// interface orientation as an integer, and 0 (unknown) deliberately rotates nothing.
public enum RunnerInterfaceOrientation {
  public static let unknown = 0
  public static let portrait = 1
  public static let portraitUpsideDown = 2
  public static let landscapeRight = 3
  public static let landscapeLeft = 4
}

/// The quarter-turn between an app's interface space and the device's native (portrait-up) space.
public enum CoordinateSpaceRotation {
  /// An interface-space point, in the native space synthesized events are performed in.
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
    default: // portrait, or an orientation the platform did not name
      return CGPoint(x: localX, y: localY)
    }
  }

  /// An interface-space translation vector, in the same native space as `native(point:)`.
  public static func native(vector: CGVector, interfaceOrientation: Int) -> CGVector {
    switch interfaceOrientation {
    case RunnerInterfaceOrientation.landscapeRight:
      return CGVector(dx: -vector.dy, dy: vector.dx)
    case RunnerInterfaceOrientation.landscapeLeft:
      return CGVector(dx: vector.dy, dy: -vector.dx)
    case RunnerInterfaceOrientation.portraitUpsideDown:
      return CGVector(dx: -vector.dx, dy: -vector.dy)
    default: // portrait, or an orientation the platform did not name
      return vector
    }
  }

  /// The inverse of `native(point:)`: a native-space point, in the app's interface space.
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
    default: // portrait, or an orientation the platform did not name
      localX = Double(point.x)
      localY = Double(point.y)
    }
    return CGPoint(x: localX + Double(frame.minX), y: localY + Double(frame.minY))
  }

  /// The inverse of `native(point:)` for a rect. A quarter turn swaps the axes, so opposite corners
  /// of the reported rect become opposite corners of the result; ordering them keeps the origin
  /// top-left, which is what every consumer of a published rect reads.
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

/// The space one captured subtree reports its rects in.
///
/// RULE: the capture publishes every rect in the app's orientation space. A surface host declares the
/// space of its own subtree — its box is either the app's box, or the app's box turned through a
/// quarter, which is how a surface hosted in the device's native space announces itself — and anything
/// below it inherits that space. Nothing is declared, and every rect stays exactly as the platform
/// reported it, when the app frame is unusable, when the interface orientation names no quarter turn
/// (portrait, or an orientation the platform did not name), or when the app frame is square. Geometry
/// the capture cannot place is not a claim about where it is, and consumers already fail open on it the
/// way they do on any missing platform fact — but the capture says so: `unplacedSurfaceHostCount`
/// counts the hosts a published tree still carries turned, so the daemon can warn instead of
/// publishing two spaces silently.
///
/// A half turn is a different claim: an upside-down app's own box is already the native box, so no
/// reported window distinguishes the two spaces and nothing is turned back. That is the same limit the
/// box-only rule accepts for a square app frame, and it is why the consumer rules in
/// `tap-keyboard-occlusion.ts` stay rather than becoming an assertion here.
public enum SnapshotGeometrySpace: Equatable {
  /** The app's own orientation space: the one every consumer of a published tree reads. */
  case appOrientation
  /** The device's native (portrait-up) space, with the way back to the app's space attached. */
  case deviceNative(appFrame: CGRect, interfaceOrientation: Int)

  /// How far a window's side lengths may miss the app's swapped side lengths and still be that
  /// quarter turn. Measured captures match to the point; this absorbs float representation only.
  public static let quarterTurnTolerance: Double = 1

  /// The reported rect, in the space the capture publishes.
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

  /// The space one node's subtree reports in.
  ///
  /// Only a surface host may declare a space: the window itself, or the surface the window hands its
  /// content to. XCTest reports `UIRemoteKeyboardWindow` with the app's own box and its child with
  /// the turned one, so the window alone is not where the turn shows up, while a deep node claiming a
  /// turned box is content whose reported bounds happen to be large and is left in the inherited
  /// space. A host that reports anything other than a turned box declares the app's space for its
  /// subtree, which is how a tree with no rotated surface stays exactly as reported.
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

  /// Whether this orientation is a turn the reported box can be measured against. Portrait and an
  /// unnamed orientation leave the device's native space upright, so nothing under them is turned.
  public static func namesQuarterTurn(_ interfaceOrientation: Int) -> Bool {
    interfaceOrientation == RunnerInterfaceOrientation.landscapeLeft
      || interfaceOrientation == RunnerInterfaceOrientation.landscapeRight
  }

  /// Whether this node, or the window above it, is where a hosted surface's box appears.
  public static func isSurfaceHost(isWindow: Bool, parentIsWindow: Bool) -> Bool {
    isWindow || parentIsWindow
  }

  /// The element type names under which a producer publishes the app's windows: the app's own
  /// window, `UITextEffectsWindow`, `UIRemoteKeyboardWindow`. XCTest models each as its own element
  /// typed `.application` or `.window`, and every producer names them this way in a published tree.
  public static func isWindowType(_ type: String) -> Bool {
    type == "Application" || type == "Window"
  }

  /// Surface hosts a published tree still carries in the device's native space.
  ///
  /// A capture that could name the app's interface orientation turned every such host back, so its
  /// published tree holds none. One that could not — the orientation read failed, or the tier had
  /// only the bridge's own root box to anchor on — publishes the host as the platform reported it,
  /// and this is where that shows: a host whose box is the viewport quarter-turned. The count is a
  /// disclosure, not a repair; it rides the quality verdict so the daemon can say which captures hold
  /// two spaces instead of letting rects under those hosts read as addresses (#2612).
  public static func unplacedSurfaceHostCount(in nodes: [RawAXNode], viewport: CGRect) -> Int {
    guard isPlottable(viewport) else { return 0 }
    // `parentIndex` is a position into this array: every producer appends nodes in traversal order
    // with `index == nodes.count` and sets a child's `parentIndex` to the parent's index, so
    // `nodes[parentIndex]` is that parent. A turned host is one surface even when both its window
    // and the surface directly under it report the turned box, so a turned node whose parent is
    // itself turned is folded into that parent rather than counted a second time.
    func turnedFrame(_ node: RawAXNode) -> Bool {
      let parentIsWindow = node.parentIndex.map { index in
        nodes.indices.contains(index) && isWindowType(nodes[index].type)
      } ?? false
      guard isSurfaceHost(isWindow: isWindowType(node.type), parentIsWindow: parentIsWindow)
      else { return false }
      return isQuarterTurned(
        CGRect(x: node.rect.x, y: node.rect.y, width: node.rect.width, height: node.rect.height),
        relativeTo: viewport
      )
    }
    var count = 0
    for node in nodes {
      guard turnedFrame(node) else { continue }
      let parentTurned = node.parentIndex.map { index in
        nodes.indices.contains(index) && turnedFrame(nodes[index])
      } ?? false
      if !parentTurned { count += 1 }
    }
    return count
  }

  /// A window that reports the app's two side lengths on the other axes is hosted in the device's
  /// native space. A square app frame cannot be told from its own quarter turn, so it is left alone
  /// rather than guessed at.
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
