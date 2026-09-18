import XCTest

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
// pixel is which. The round-trip test below is that proof, not a comment asking for care.

/// The UIInterfaceOrientation raw values the rotation table switches on. XCTest exposes the app's
/// interface orientation as an integer, and 0 (unknown) deliberately rotates nothing.
enum RunnerInterfaceOrientation {
  static let unknown = 0
  static let portrait = 1
  static let portraitUpsideDown = 2
  static let landscapeRight = 3
  static let landscapeLeft = 4
}

/// The quarter-turn between an app's interface space and the device's native (portrait-up) space.
enum CoordinateSpaceRotation {
  /// An interface-space point, in the native space synthesized events are performed in.
  static func native(
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
  static func native(vector: CGVector, interfaceOrientation: Int) -> CGVector {
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
  static func oriented(
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
  static func oriented(
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
/// way they do on any missing platform fact.
///
/// A half turn is a different claim: an upside-down app's own box is already the native box, so no
/// reported window distinguishes the two spaces and nothing is turned back. That is the same limit the
/// box-only rule accepts for a square app frame, and it is why the consumer rules in
/// `tap-keyboard-occlusion.ts` stay rather than becoming an assertion here.
enum SnapshotGeometrySpace: Equatable {
  /** The app's own orientation space: the one every consumer of a published tree reads. */
  case appOrientation
  /** The device's native (portrait-up) space, with the way back to the app's space attached. */
  case deviceNative(appFrame: CGRect, interfaceOrientation: Int)

  /// How far a window's side lengths may miss the app's swapped side lengths and still be that
  /// quarter turn. Measured captures match to the point; this absorbs float representation only.
  static let quarterTurnTolerance: Double = 1

  /// The reported rect, in the space the capture publishes.
  func orientedFrame(of reportedFrame: CGRect) -> CGRect {
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
  static func space(
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
  static func namesQuarterTurn(_ interfaceOrientation: Int) -> Bool {
    interfaceOrientation == RunnerInterfaceOrientation.landscapeLeft
      || interfaceOrientation == RunnerInterfaceOrientation.landscapeRight
  }

  /// Whether this node, or the window above it, is where a hosted surface's box appears.
  static func isSurfaceHost(
    elementType: XCUIElement.ElementType?,
    parentIsWindow: Bool
  ) -> Bool {
    elementType == .application || elementType == .window || parentIsWindow
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

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
private struct WindowCoordinateSpaceFixture: Decodable {
  /// A frame as JSON can carry one. Infinity has no JSON spelling, so the unusable box a platform
  /// hands back is named `{"infinite": true}`: `CGRect.infinite` here, and an infinite rect in the
  /// vitest twin.
  struct Frame: Decodable {
    private enum CodingKeys: String, CodingKey {
      case x, y, width, height, infinite
    }

    let cgRect: CGRect

    init(from decoder: Decoder) throws {
      let container = try decoder.container(keyedBy: CodingKeys.self)
      guard try container.decodeIfPresent(Bool.self, forKey: .infinite) != true else {
        self.cgRect = .infinite
        return
      }
      self.cgRect = CGRect(
        x: try container.decode(Double.self, forKey: .x),
        y: try container.decode(Double.self, forKey: .y),
        width: try container.decode(Double.self, forKey: .width),
        height: try container.decode(Double.self, forKey: .height)
      )
    }
  }

  struct Constants: Decodable {
    let quarterTurnTolerance: Double
  }

  struct QuarterTurnCase: Decodable {
    let name: String
    let window: Frame
    let app: Frame
    let quarterTurned: Bool
  }

  struct RotationCase: Decodable {
    let name: String
    let interfaceOrientation: Int
    let app: Frame
    let native: Frame
    let oriented: Frame
  }

  let constants: Constants
  let quarterTurnCases: [QuarterTurnCase]
  let rotationCases: [RotationCase]
}

extension RunnerTests {
  /// Identity in portrait/unknown, 90° per landscape, 180° upside-down.
  func testNativeSynthesizedPointRotatesByInterfaceOrientation() {
    let portrait = CGRect(x: 0, y: 0, width: 834, height: 1210)
    let landscape = CGRect(x: 0, y: 0, width: 1210, height: 834)
    let offsetLandscape = CGRect(x: 10, y: 20, width: 1210, height: 834)
    // (frame, UIInterfaceOrientation, expected native point) for a tap at (170, 268).
    let cases: [(CGRect, Int, CGPoint)] = [
      (portrait, RunnerInterfaceOrientation.portrait, CGPoint(x: 170, y: 268)),
      (landscape, RunnerInterfaceOrientation.landscapeRight, CGPoint(x: 566, y: 170)),
      (landscape, RunnerInterfaceOrientation.landscapeLeft, CGPoint(x: 268, y: 1040)),
      (portrait, RunnerInterfaceOrientation.portraitUpsideDown, CGPoint(x: 664, y: 942)),
      (portrait, RunnerInterfaceOrientation.unknown, CGPoint(x: 170, y: 268)),
    ]
    for (frame, orientation, expected) in cases {
      XCTAssertEqual(
        CoordinateSpaceRotation.native(
          point: CGPoint(x: 170, y: 268),
          in: frame,
          interfaceOrientation: orientation
        ),
        expected,
        "interfaceOrientation \(orientation)"
      )
    }
    XCTAssertEqual(
      CoordinateSpaceRotation.native(
        point: CGPoint(x: 180, y: 288),
        in: offsetLandscape,
        interfaceOrientation: RunnerInterfaceOrientation.landscapeLeft
      ),
      CGPoint(x: 268, y: 1040),
      "non-zero frame origin is localized before rotation"
    )
  }

  func testNativeSynthesizedVectorRotatesByInterfaceOrientation() {
    let cases: [(Int, CGVector)] = [
      (RunnerInterfaceOrientation.portrait, CGVector(dx: 40, dy: -20)),
      (RunnerInterfaceOrientation.landscapeRight, CGVector(dx: 20, dy: 40)),
      (RunnerInterfaceOrientation.landscapeLeft, CGVector(dx: -20, dy: -40)),
      (RunnerInterfaceOrientation.portraitUpsideDown, CGVector(dx: -40, dy: 20)),
      (RunnerInterfaceOrientation.unknown, CGVector(dx: 40, dy: -20)),
    ]
    for (orientation, expected) in cases {
      let vector = CoordinateSpaceRotation.native(
        vector: CGVector(dx: 40, dy: -20),
        interfaceOrientation: orientation
      )
      XCTAssertEqual(vector.dx, expected.dx, "dx interfaceOrientation \(orientation)")
      XCTAssertEqual(vector.dy, expected.dy, "dy interfaceOrientation \(orientation)")
    }
  }

  /// Capture rotates back with the exact inverse of what dispatch rotates forward. A landscape
  /// rotation that drifts on one side only fails here; the two paths cannot disagree silently.
  func testOrientationRotationRoundTripsBetweenInterfaceAndNativeSpace() {
    let orientations = [
      RunnerInterfaceOrientation.portrait,
      RunnerInterfaceOrientation.portraitUpsideDown,
      RunnerInterfaceOrientation.landscapeRight,
      RunnerInterfaceOrientation.landscapeLeft,
      RunnerInterfaceOrientation.unknown,
    ]
    let frames = [
      CGRect(x: 0, y: 0, width: 402, height: 874),
      CGRect(x: 0, y: 0, width: 874, height: 402),
      CGRect(x: 12, y: 24, width: 834, height: 1194),
    ]
    for frame in frames {
      for orientation in orientations {
        for point in [
          CGPoint(x: 0, y: 0),
          CGPoint(x: 170.5, y: 268),
          CGPoint(x: 401, y: 873),
        ] {
          let native = CoordinateSpaceRotation.native(
            point: point,
            in: frame,
            interfaceOrientation: orientation
          )
          XCTAssertEqual(
            CoordinateSpaceRotation.oriented(
              point: native,
              in: frame,
              interfaceOrientation: orientation
            ),
            point,
            "point (\(point.x), \(point.y)) frame \(frame) orientation \(orientation)"
          )
        }
      }
    }
  }

  /// The measured landscape keyboard (#2612): the plane arrives as a strip on the left edge in the
  /// device's native space and has to come back as the band docked at the bottom of the app's
  /// viewport. `y 198` is not a guess — it is what the runner's live `app.keyboards` query answered
  /// for the same keyboard on the same screen, and the screenshot draws the keys there.
  func testDeviceNativeGeometryRestoresTheMeasuredLandscapeKeyboardBand() {
    let landscape = RunnerInterfaceOrientation.landscapeRight
    let appFrame = CGRect(x: 0, y: 0, width: 874, height: 402)
    let space = SnapshotGeometrySpace.space(
      reportedBySurfaceHost: true,
      reportedFrame: CGRect(x: 0, y: 0, width: 402, height: 874),
      inheritedFrom: .appOrientation,
      appFrame: appFrame,
      interfaceOrientation: landscape
    )
    XCTAssertEqual(space, .deviceNative(appFrame: appFrame, interfaceOrientation: landscape))

    // Reported on iPhone 17 Pro (iOS 26.2), landscape, system keyboard over the fixture's form.
    XCTAssertEqual(
      space.orientedFrame(of: CGRect(x: 0, y: 0, width: 402, height: 874)),
      appFrame
    )
    XCTAssertEqual(
      space.orientedFrame(of: CGRect(x: 2, y: 75, width: 202, height: 724)),
      CGRect(x: 75, y: 198, width: 724, height: 202)
    )
    XCTAssertEqual(
      space.orientedFrame(of: CGRect(x: 154, y: 77, width: 45, height: 72)),
      CGRect(x: 77, y: 203, width: 72, height: 45)
    )
    XCTAssertEqual(
      space.orientedFrame(of: CGRect(x: 0, y: 8, width: 65, height: 68)),
      CGRect(x: 8, y: 337, width: 68, height: 65)
    )
    // A zero-area padding key stays zero-area: it carries no geometry for anything to measure.
    XCTAssertEqual(
      space.orientedFrame(of: CGRect(x: 204, y: 75, width: 0, height: 0)),
      CGRect(x: 75, y: 198, width: 0, height: 0)
    )
  }

  /// Which windows declare a space, and when the capture leaves geometry alone.
  func testGeometrySpaceIsDeclaredByAQuarterTurnedWindowOnly() {
    let appFrame = CGRect(x: 0, y: 0, width: 874, height: 402)
    let rotated = CGRect(x: 0, y: 0, width: 402, height: 874)
    let nativeSpace = SnapshotGeometrySpace.space(
      reportedBySurfaceHost: true,
      reportedFrame: rotated,
      inheritedFrom: .appOrientation,
      appFrame: appFrame,
      interfaceOrientation: RunnerInterfaceOrientation.landscapeRight
    )

    // The app's own window reports the app's box, and so does a hosted surface that already
    // tracks the interface rotation (`UITextEffectsWindow` does).
    XCTAssertEqual(
      SnapshotGeometrySpace.space(
        reportedBySurfaceHost: true,
        reportedFrame: appFrame,
        inheritedFrom: nativeSpace,
        appFrame: appFrame,
        interfaceOrientation: RunnerInterfaceOrientation.landscapeRight
      ),
      .appOrientation
    )
    // Anything that is not a window inherits: a key under the keyboard window stays native-space.
    XCTAssertEqual(
      SnapshotGeometrySpace.space(
        reportedBySurfaceHost: SnapshotGeometrySpace.isSurfaceHost(
          elementType: XCUIElement.ElementType(rawValue: 20),
          parentIsWindow: false
        ),
        reportedFrame: CGRect(x: 154, y: 77, width: 45, height: 72),
        inheritedFrom: nativeSpace,
        appFrame: appFrame,
        interfaceOrientation: RunnerInterfaceOrientation.landscapeRight
      ),
      nativeSpace
    )
    // No orientation named: nothing was declared, so the capture publishes what the platform reported
    // rather than inventing a rotation.
    let unnamed = SnapshotGeometrySpace.space(
      reportedBySurfaceHost: true,
      reportedFrame: rotated,
      inheritedFrom: .appOrientation,
      appFrame: appFrame,
      interfaceOrientation: RunnerInterfaceOrientation.unknown
    )
    XCTAssertEqual(unnamed, .appOrientation)
    XCTAssertEqual(
      unnamed.orientedFrame(of: CGRect(x: 154, y: 77, width: 45, height: 72)),
      CGRect(x: 154, y: 77, width: 45, height: 72)
    )
    // A portrait app cannot be quarter-turned either, however the box is reported.
    XCTAssertEqual(
      SnapshotGeometrySpace.space(
        reportedBySurfaceHost: true,
        reportedFrame: rotated,
        inheritedFrom: .appOrientation,
        appFrame: CGRect(x: 16, y: 24, width: 874, height: 402),
        interfaceOrientation: RunnerInterfaceOrientation.portrait
      ),
      .appOrientation
    )
    // An app frame the capture could not resolve cannot anchor a rotation.
    XCTAssertEqual(
      SnapshotGeometrySpace.space(
        reportedBySurfaceHost: true,
        reportedFrame: rotated,
        inheritedFrom: .appOrientation,
        appFrame: .infinite,
        interfaceOrientation: RunnerInterfaceOrientation.landscapeRight
      ),
      .appOrientation
    )
    // A square app cannot be told from its own quarter turn, so its geometry is left alone.
    let square = CGRect(x: 0, y: 0, width: 800, height: 800)
    XCTAssertEqual(
      SnapshotGeometrySpace.space(
        reportedBySurfaceHost: true,
        reportedFrame: square,
        inheritedFrom: .appOrientation,
        appFrame: square,
        interfaceOrientation: RunnerInterfaceOrientation.landscapeRight
      ),
      .appOrientation
    )
  }

  /// Golden parity table (#2612): every case in contracts/fixtures/window-coordinate-space.json
  /// must agree with the vitest twin
  /// (packages/platform-apple/src/snapshot-source/window-coordinate-space.test.ts). Add
  /// cases there, never fork the rule. Detection is replayed under both landscape turns, because
  /// which window declares the native space cannot depend on which way the app is turned; the
  /// rotation rows carry their own orientation.
  func testWindowCoordinateSpaceMatchesGoldenParityTable() throws {
    let fixtureURL = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent() // AgentDeviceRunnerUITests
      .deletingLastPathComponent() // AgentDeviceRunner
      .deletingLastPathComponent() // runner
      .deletingLastPathComponent() // apple
      .deletingLastPathComponent() // repo root
      .appendingPathComponent("contracts")
      .appendingPathComponent("fixtures")
      .appendingPathComponent("window-coordinate-space.json")
    let fixture = try JSONDecoder().decode(
      WindowCoordinateSpaceFixture.self,
      from: Data(contentsOf: fixtureURL)
    )
    XCTAssertFalse(fixture.quarterTurnCases.isEmpty, "parity table must not be empty")
    XCTAssertFalse(fixture.rotationCases.isEmpty, "parity table must not be empty")
    XCTAssertEqual(
      fixture.constants.quarterTurnTolerance,
      SnapshotGeometrySpace.quarterTurnTolerance,
      "the tolerance is the table's, not this file's"
    )
    for testCase in fixture.quarterTurnCases {
      let appFrame = testCase.app.cgRect
      for interfaceOrientation in [
        RunnerInterfaceOrientation.landscapeRight, RunnerInterfaceOrientation.landscapeLeft
      ] {
        let expected: SnapshotGeometrySpace = testCase.quarterTurned
          ? .deviceNative(appFrame: appFrame, interfaceOrientation: interfaceOrientation)
          : .appOrientation
        XCTAssertEqual(
          SnapshotGeometrySpace.space(
            reportedBySurfaceHost: true,
            reportedFrame: testCase.window.cgRect,
            inheritedFrom: .appOrientation,
            appFrame: appFrame,
            interfaceOrientation: interfaceOrientation
          ),
          expected,
          "\(testCase.name) (interfaceOrientation \(interfaceOrientation))"
        )
      }
    }
    for testCase in fixture.rotationCases {
      XCTAssertEqual(
        CoordinateSpaceRotation.oriented(
          rect: testCase.native.cgRect,
          in: testCase.app.cgRect,
          interfaceOrientation: testCase.interfaceOrientation
        ),
        testCase.oriented.cgRect,
        testCase.name
      )
    }
  }
}
#endif

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
extension RunnerTests {
  /// Where a turned box has to appear before it declares a space.
  func testOnlyASurfaceHostDeclaresTheCoordinateSpaceOfItsSubtree() {
    let appFrame = CGRect(x: 0, y: 0, width: 874, height: 402)
    let turned = CGRect(x: 0, y: 0, width: 402, height: 874)
    let landscape = RunnerInterfaceOrientation.landscapeRight

    // XCTest gives `UIRemoteKeyboardWindow` the app's own box and its child the turned one, so the
    // surface below a window is a host too.
    XCTAssertTrue(
      SnapshotGeometrySpace.isSurfaceHost(
        elementType: XCUIElement.ElementType(rawValue: 21),
        parentIsWindow: true
      )
    );
    XCTAssertFalse(
      SnapshotGeometrySpace.isSurfaceHost(
        elementType: XCUIElement.ElementType(rawValue: 21),
        parentIsWindow: false
      )
    );

    let windowSpace = SnapshotGeometrySpace.space(
      reportedBySurfaceHost: true,
      reportedFrame: appFrame,
      inheritedFrom: .appOrientation,
      appFrame: appFrame,
      interfaceOrientation: landscape
    )
    XCTAssertEqual(windowSpace, .appOrientation)
    let surfaceSpace = SnapshotGeometrySpace.space(
      reportedBySurfaceHost: true,
      reportedFrame: turned,
      inheritedFrom: windowSpace,
      appFrame: appFrame,
      interfaceOrientation: landscape
    )
    XCTAssertEqual(surfaceSpace, .deviceNative(appFrame: appFrame, interfaceOrientation: landscape))
    // Deep in the tree a turned box is content reporting large bounds, not a hosted surface: it keeps
    // the space it inherited rather than rewriting the space below it.
    XCTAssertEqual(
      SnapshotGeometrySpace.space(
        reportedBySurfaceHost: false,
        reportedFrame: turned,
        inheritedFrom: windowSpace,
        appFrame: appFrame,
        interfaceOrientation: landscape
      ),
      .appOrientation
    )
  }
}
#endif
