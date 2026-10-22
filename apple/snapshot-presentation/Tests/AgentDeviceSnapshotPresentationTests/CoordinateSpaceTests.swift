import AgentDeviceSnapshotPresentation
import CoreGraphics
import Foundation
import XCTest

/// The rotation table and the space a captured window declares (#2612). Pure geometry: it runs here,
/// without a simulator, and the runner's walkers are tested separately for threading it through.
final class CoordinateSpaceTests: XCTestCase {
  private struct WindowCoordinateSpaceFixture: Decodable {
    typealias Frame = FixtureRect

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

    struct WindowContentCase: Decodable {
      let name: String
      let reportedBox: Frame
      let viewportBox: Frame
      let offset: Offset?
    }

    struct Offset: Decodable {
      let width: Double
      let height: Double
    }

    let constants: Constants
    let quarterTurnCases: [QuarterTurnCase]
    let rotationCases: [RotationCase]
    let windowContentCases: [WindowContentCase]
  }

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
      CGPoint(x: 288, y: 1030),
      "a frame offset from the screen never moves the turned point (#3899)"
    );
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
      viewport: .reported(box: appFrame, interfaceOrientation: landscape)
    )
    XCTAssertEqual(space, deviceNative(appFrame, landscape))

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
      viewport: .reported(
        box: appFrame,
        interfaceOrientation: RunnerInterfaceOrientation.landscapeRight
      )
    )

    // The app's own window reports the app's box, and so does a hosted surface that already
    // tracks the interface rotation (`UITextEffectsWindow` does).
    XCTAssertEqual(
      SnapshotGeometrySpace.space(
        reportedBySurfaceHost: true,
        reportedFrame: appFrame,
        inheritedFrom: nativeSpace,
        viewport: .reported(
          box: appFrame,
          interfaceOrientation: RunnerInterfaceOrientation.landscapeRight
        )
      ),
      .appOrientation
    )
    // Anything that is not a window inherits: a key under the keyboard window stays native-space.
    XCTAssertEqual(
      SnapshotGeometrySpace.space(
        reportedBySurfaceHost: SnapshotGeometrySpace.isSurfaceHost(
          isWindow: false,
          parentIsWindow: false
        ),
        reportedFrame: CGRect(x: 154, y: 77, width: 45, height: 72),
        inheritedFrom: nativeSpace,
        viewport: .reported(
          box: appFrame,
          interfaceOrientation: RunnerInterfaceOrientation.landscapeRight
        )
      ),
      nativeSpace
    )
    // No orientation named: nothing was declared, so the capture publishes what the platform reported
    // rather than inventing a rotation.
    let unnamed = SnapshotGeometrySpace.space(
      reportedBySurfaceHost: true,
      reportedFrame: rotated,
      inheritedFrom: .appOrientation,
      viewport: .reported(box: appFrame, interfaceOrientation: RunnerInterfaceOrientation.unknown)
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
        viewport: .reported(
          box: CGRect(x: 16, y: 24, width: 874, height: 402),
          interfaceOrientation: RunnerInterfaceOrientation.portrait
        )
      ),
      .appOrientation
    )
    // Only a reported viewport carries an orientation: no box, or a box the capture derived from
    // its own root, cannot anchor a rotation (#2891).
    for viewport in [SnapshotViewport.missing(reason: .notProvided), .derived(box: appFrame)] {
      XCTAssertEqual(
        SnapshotGeometrySpace.space(
          reportedBySurfaceHost: true,
          reportedFrame: rotated,
          inheritedFrom: .appOrientation,
          viewport: viewport
        ),
        .appOrientation
      )
    }
    // A square app cannot be told from its own quarter turn, so its geometry is left alone.
    let square = CGRect(x: 0, y: 0, width: 800, height: 800)
    XCTAssertEqual(
      SnapshotGeometrySpace.space(
        reportedBySurfaceHost: true,
        reportedFrame: square,
        inheritedFrom: .appOrientation,
        viewport: .reported(
          box: square,
          interfaceOrientation: RunnerInterfaceOrientation.landscapeRight
        )
      ),
      .appOrientation
    )
  }

  /// Where a turned box has to appear before it declares a space.
  func testOnlyASurfaceHostDeclaresTheCoordinateSpaceOfItsSubtree() {
    let appFrame = CGRect(x: 0, y: 0, width: 874, height: 402)
    let turned = CGRect(x: 0, y: 0, width: 402, height: 874)
    let landscape = RunnerInterfaceOrientation.landscapeRight

    // XCTest gives `UIRemoteKeyboardWindow` the app's own box and its child the turned one, so the
    // surface below a window is a host too.
    XCTAssertTrue(SnapshotGeometrySpace.isSurfaceHost(isWindow: false, parentIsWindow: true))
    XCTAssertFalse(SnapshotGeometrySpace.isSurfaceHost(isWindow: false, parentIsWindow: false))

    let windowSpace = SnapshotGeometrySpace.space(
      reportedBySurfaceHost: true,
      reportedFrame: appFrame,
      inheritedFrom: .appOrientation,
      viewport: .reported(box: appFrame, interfaceOrientation: landscape)
    )
    XCTAssertEqual(windowSpace, .appOrientation)
    let surfaceSpace = SnapshotGeometrySpace.space(
      reportedBySurfaceHost: true,
      reportedFrame: turned,
      inheritedFrom: windowSpace,
      viewport: .reported(box: appFrame, interfaceOrientation: landscape)
    )
    XCTAssertEqual(surfaceSpace, deviceNative(appFrame, landscape))
    // Deep in the tree a turned box is content reporting large bounds, not a hosted surface: it keeps
    // the space it inherited rather than rewriting the space below it.
    XCTAssertEqual(
      SnapshotGeometrySpace.space(
        reportedBySurfaceHost: false,
        reportedFrame: turned,
        inheritedFrom: windowSpace,
        viewport: .reported(box: appFrame, interfaceOrientation: landscape)
      ),
      .appOrientation
    )
  }

  /// Golden parity table (#2612, #3899): every case in contracts/fixtures/window-coordinate-space.json
  /// must agree with the vitest twin
  /// (packages/platform-apple/src/snapshot-source/window-coordinate-space.test.ts). Add
  /// cases there, never fork the rule. Detection is replayed under both landscape turns, because
  /// which window declares the native space cannot depend on which way the app is turned; the
  /// rotation rows carry their own orientation.
  func testWindowCoordinateSpaceMatchesGoldenParityTable() throws {
    let fixture = try loadWindowCoordinateSpaceFixture()
    XCTAssertFalse(fixture.quarterTurnCases.isEmpty, "parity table must not be empty")
    XCTAssertFalse(fixture.rotationCases.isEmpty, "parity table must not be empty")
    XCTAssertFalse(fixture.windowContentCases.isEmpty, "parity table must not be empty")
    XCTAssertEqual(
      Set(fixture.quarterTurnCases.map(\.name)).count,
      fixture.quarterTurnCases.count,
      "parity table case names must be unique"
    )
    XCTAssertEqual(
      Set(fixture.rotationCases.map(\.name)).count,
      fixture.rotationCases.count,
      "parity table case names must be unique"
    )
    XCTAssertEqual(
      Set(fixture.windowContentCases.map(\.name)).count,
      fixture.windowContentCases.count,
      "parity table case names must be unique"
    )
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
          ? deviceNative(appFrame, interfaceOrientation)
          : .appOrientation
        XCTAssertEqual(
          SnapshotGeometrySpace.space(
            reportedBySurfaceHost: true,
            reportedFrame: testCase.window.cgRect,
            inheritedFrom: .appOrientation,
            viewport: .reported(box: appFrame, interfaceOrientation: interfaceOrientation)
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
    for testCase in fixture.windowContentCases {
      let expected = testCase.offset.map { CGSize(width: $0.width, height: $0.height) }
      XCTAssertEqual(
        SnapshotContentTranslation.offset(
          reportedBox: testCase.reportedBox.cgRect,
          viewportBox: testCase.viewportBox.cgRect
        ),
        expected,
        testCase.name
      )
    }
  }

  private func deviceNative(_ appFrame: CGRect, _ interfaceOrientation: Int) -> SnapshotGeometrySpace {
    guard case .reported(let box, _) = SnapshotViewport.reported(box: appFrame) else {
      preconditionFailure("\(appFrame) is not a viewport box")
    }
    return .deviceNative(appFrame: box, interfaceOrientation: interfaceOrientation)
  }

  private func loadWindowCoordinateSpaceFixture() throws -> WindowCoordinateSpaceFixture {
    let fixtureURL = contractsFixtureURL("window-coordinate-space.json")
    return try JSONDecoder().decode(
      WindowCoordinateSpaceFixture.self,
      from: Data(contentsOf: fixtureURL)
    )
  }

  /// Application → the app's own Window → a surface host reporting the turned box (which declares
  /// the device's native space for its subtree) → the content whose reported frame must come back.
  private func turnedSubtree(app: CGRect, reportedLeaf: CGRect) -> [RawAXNode] {
    let turnedHostBox = CGRect(x: app.origin.x, y: app.origin.y, width: app.height, height: app.width)
    return [
      coordinateNode(0, "Application", app, nil, 0),
      coordinateNode(1, "Window", app, 0, 1),
      coordinateNode(2, "Other", turnedHostBox, 1, 2),
      coordinateNode(3, "Button", reportedLeaf, 2, 3),
    ]
  }

  private func coordinateNode(
    _ index: Int, _ type: String, _ rect: CGRect, _ parent: Int?, _ depth: Int, label: String? = nil
  ) -> RawAXNode {
    RawAXNode(
      index: index, type: type, label: label, identifier: nil, value: nil,
      rect: SnapshotRect(x: rect.minX, y: rect.minY, width: rect.width, height: rect.height),
      enabled: true, focused: nil, selected: nil, hittable: false,
      depth: depth, parentIndex: parent, hiddenContentAbove: nil, hiddenContentBelow: nil
    )
  }

  /// The one normalization pass is where capture turns geometry, so the golden table's rotation rows
  /// are replayed through a real tree, not just the raw rotation: a quarter turn comes back in the
  /// app's space, while a half turn, an unnamed orientation, or a square app box stays as reported.
  func testNormalizedReplaysRotationCasesThroughATwoWindowTree() throws {
    let fixture = try loadWindowCoordinateSpaceFixture()
    for testCase in fixture.rotationCases {
      let app = testCase.app.cgRect
      let namesQuarterTurn =
        testCase.interfaceOrientation == RunnerInterfaceOrientation.landscapeLeft
        || testCase.interfaceOrientation == RunnerInterfaceOrientation.landscapeRight
      let squareApp = abs(app.width - app.height) <= SnapshotGeometrySpace.quarterTurnTolerance
      let expected = (namesQuarterTurn && !squareApp) ? testCase.oriented : testCase.native
      let normalized = SnapshotGeometrySpace.normalized(
        nodes: turnedSubtree(app: app, reportedLeaf: testCase.native.cgRect),
        viewport: .reported(box: app, interfaceOrientation: testCase.interfaceOrientation)
      )
      XCTAssertEqual(normalized.count, 4)
      XCTAssertEqual(normalized[3].rect.cgRect, expected.cgRect, testCase.name)
    }
  }

  /// The measured iPhone 17 Pro landscape keyboard (#2612) driven through the pass: the key plane
  /// returns as the band docked at the bottom, `q` lands on the band and is actionable once turned.
  func testNormalizedRestoresTheMeasuredLandscapeKeyboardBand() {
    let app = CGRect(x: 0, y: 0, width: 874, height: 402)
    let turnedHostBox = CGRect(x: 0, y: 0, width: 402, height: 874)
    let acquired = [
      coordinateNode(0, "Application", app, nil, 0, label: "app"),
      coordinateNode(1, "Window", app, 0, 1, label: "window"),
      coordinateNode(2, "Other", turnedHostBox, 1, 2, label: "plane"),
      coordinateNode(3, "Key", CGRect(x: 2, y: 75, width: 202, height: 724), 2, 3, label: "planeBand"),
      coordinateNode(4, "Key", CGRect(x: 154, y: 77, width: 45, height: 72), 2, 3, label: "q"),
    ]
    let normalized = SnapshotGeometrySpace.normalized(
      nodes: acquired,
      viewport: .reported(box: app, interfaceOrientation: RunnerInterfaceOrientation.landscapeRight)
    )
    XCTAssertEqual(
      normalized.first { $0.label == "planeBand" }?.rect,
      SnapshotRect(x: 75, y: 198, width: 724, height: 202)
    )
    let keyQ = normalized.first { $0.label == "q" }
    XCTAssertEqual(keyQ?.rect, SnapshotRect(x: 77, y: 203, width: 72, height: 45))
    XCTAssertEqual(keyQ?.hittable, true)
    XCTAssertEqual(normalized.first?.hittable, false)
  }

  /// The query-sweep tier's flat nodes hang off a synthetic root reporting the app's own box under an
  /// unnamed orientation, so nothing declares a native space: the pass returns the tree unchanged and
  /// only recomputes hittability from the app-space frame.
  func testNormalizedLeavesAWindowlessFlatTreeUnplaced() {
    let app = CGRect(x: 0, y: 0, width: 874, height: 402)
    let onscreen = CGRect(x: 100, y: 100, width: 40, height: 20)
    let offscreen = CGRect(x: 900, y: 10, width: 40, height: 20)
    let acquired = [
      coordinateNode(0, "Application", app, nil, 0),
      coordinateNode(1, "Button", onscreen, 0, 1),
      coordinateNode(2, "Button", offscreen, 0, 1),
    ]
    let normalized = SnapshotGeometrySpace.normalized(
      nodes: acquired,
      viewport: .reported(box: app, interfaceOrientation: RunnerInterfaceOrientation.unknown)
    )
    XCTAssertEqual(normalized.map(\.rect), acquired.map(\.rect))
    XCTAssertEqual(normalized[1].hittable, true)
    XCTAssertEqual(normalized[2].hittable, false)
    XCTAssertEqual(normalized[0].hittable, false)
  }

  /// Without a viewport box the pass turns nothing and cannot decide containment, so a child's
  /// `hittable` is absent rather than declared; a disabled child is still declared `false` (#2891).
  func testNormalizedWithoutAViewportLeavesContainmentUndecided() {
    let app = CGRect(x: 0, y: 0, width: 874, height: 402)
    let acquired = turnedSubtree(app: app, reportedLeaf: CGRect(x: 100, y: 100, width: 40, height: 20))
    let normalized = SnapshotGeometrySpace.normalized(
      nodes: acquired,
      viewport: .missing(reason: .notProvided)
    )
    XCTAssertEqual(normalized.map(\.rect), acquired.map(\.rect))
    XCTAssertEqual(normalized[0].hittable, false)
    XCTAssertNil(normalized[3].hittable)

    let disabled = RawAXNode(
      index: 1, type: "Button", label: nil, identifier: nil, value: nil,
      rect: SnapshotRect(x: 100, y: 100, width: 40, height: 20),
      enabled: false, focused: nil, selected: nil, hittable: true,
      depth: 1, parentIndex: 0, hiddenContentAbove: nil, hiddenContentBelow: nil
    )
    XCTAssertEqual(
      SnapshotGeometrySpace.normalized(
        nodes: [acquired[0], disabled],
        viewport: .missing(reason: .notProvided)
      )[1].hittable,
      false
    )
  }

  /// The measured windowed iPad Calendar window (#3899) driven through the pass: the carrier reports
  /// a `(0,0)`-anchored copy of the viewport box, declares its subtree window-relative, and every
  /// rect under it comes back at its place on the screen — the root at the window's screen box, the
  /// Add button at (559,221) where the screenshot draws it, and a full-screen-capture tree untouched.
  func testNormalizedTranslatesAWindowedSubtreeIntoScreenSpace() {
    let windowOnScreen = CGRect(x: 224, y: 207, width: 386, height: 682)
    let reportedRoot = CGRect(x: 0, y: 0, width: 386, height: 682)
    let reportedAddButton = CGRect(x: 335, y: 14, width: 37, height: 36)
    let acquired = [
      coordinateNode(0, "Application", reportedRoot, nil, 0, label: "Calendar"),
      coordinateNode(1, "Window", reportedRoot, 0, 1),
      coordinateNode(2, "Other", reportedRoot, 1, 2),
      coordinateNode(3, "Button", reportedAddButton, 2, 3, label: "Add"),
    ]
    let normalized = SnapshotGeometrySpace.normalized(
      nodes: acquired,
      viewport: .reported(box: windowOnScreen, interfaceOrientation: RunnerInterfaceOrientation.portrait)
    )
    XCTAssertEqual(normalized[0].rect.cgRect, windowOnScreen)
    XCTAssertEqual(normalized[1].rect.cgRect, windowOnScreen)
    XCTAssertEqual(normalized[2].rect.cgRect, windowOnScreen)
    XCTAssertEqual(normalized[3].rect.cgRect, CGRect(x: 559, y: 221, width: 37, height: 36))
    XCTAssertEqual(normalized[3].hittable, true)

    // The same window moved: the subtree follows the new origin.
    let moved = SnapshotGeometrySpace.normalized(
      nodes: acquired,
      viewport: .reported(
        box: CGRect(x: 120, y: 90, width: 386, height: 682),
        interfaceOrientation: RunnerInterfaceOrientation.portrait
      )
    )
    XCTAssertEqual(moved[3].rect.cgRect, CGRect(x: 455, y: 104, width: 37, height: 36))
  }

  /// What must not move: a full-screen capture, and any subtree under a carrier that is not the app's
  /// own placed window. Those trees keep exactly the rect the platform reported (#3899 keeps
  /// full-screen and ADR 0025 panel behavior identical).
  func testNormalizedTranslatesNothingForFullScreenAndForeignCarriers() {
    // Full-screen iPad: reported boxes already start at the viewport.
    let fullScreen = CGRect(x: 0, y: 0, width: 834, height: 1210)
    let acquired = [
      coordinateNode(0, "Application", fullScreen, nil, 0),
      coordinateNode(1, "Window", fullScreen, 0, 1),
      coordinateNode(2, "Button", CGRect(x: 335, y: 14, width: 37, height: 36), 1, 2),
    ]
    XCTAssertEqual(
      SnapshotGeometrySpace.normalized(
        nodes: acquired,
        viewport: .reported(
          box: fullScreen,
          interfaceOrientation: RunnerInterfaceOrientation.portrait
        )
      ).map(\.rect),
      acquired.map(\.rect)
    );

    // A windowed app, measured shape: the app's own window declares the translation and carries the
    // subtree; the keyboard window and the SpringBoard overlay report the screen's own box, so their
    // subtrees stay where the platform put them.
    let windowOnScreen = CGRect(x: 224, y: 207, width: 386, height: 682)
    let reportedRoot = CGRect(x: 0, y: 0, width: 386, height: 682)
    let mixed = [
      coordinateNode(0, "Application", reportedRoot, nil, 0),
      coordinateNode(1, "Window", reportedRoot, 0, 1, label: "appWindow"),
      coordinateNode(2, "Other", reportedRoot, 1, 2),
      coordinateNode(3, "Button", CGRect(x: 335, y: 14, width: 37, height: 36), 2, 3, label: "Add"),
      coordinateNode(4, "Window", CGRect(x: 0, y: 925, width: 834, height: 282), 0, 1, label: "keyboard"),
      coordinateNode(5, "Key", CGRect(x: 300, y: 1100, width: 60, height: 60), 4, 2),
      coordinateNode(6, "Window", CGRect(x: 0, y: 0, width: 834, height: 1210), 0, 1, label: "springboard"),
      coordinateNode(7, "Alert", CGRect(x: 300, y: 500, width: 240, height: 160), 6, 2),
    ]
    let normalized = SnapshotGeometrySpace.normalized(
      nodes: mixed,
      viewport: .reported(box: windowOnScreen, interfaceOrientation: RunnerInterfaceOrientation.portrait)
    )
    XCTAssertEqual(normalized[1].rect.cgRect, windowOnScreen, "appWindow")
    XCTAssertEqual(normalized[2].rect.cgRect, windowOnScreen)
    XCTAssertEqual(normalized[3].rect.cgRect, CGRect(x: 559, y: 221, width: 37, height: 36))
    XCTAssertEqual(normalized[4].rect, mixed[4].rect, "keyboard")
    XCTAssertEqual(normalized[5].rect, mixed[5].rect)
    XCTAssertEqual(normalized[6].rect, mixed[6].rect, "springboard")
    XCTAssertEqual(normalized[7].rect, mixed[7].rect)
  }

  /// The dispatch direction for a windowed app: the caller's point is the point touched, so
  /// `native(point:)` turns a screen-space point's axes without moving it toward the window origin
  /// (#3899). Under portrait — the only orientation measured for a windowed app — it is the identity.
  func testNativePointForAWindowedAppKeepsTheCallersScreenPoint() {
    let windowOnScreen = CGRect(x: 224, y: 207, width: 386, height: 682)
    for orientation in [
      RunnerInterfaceOrientation.portrait, RunnerInterfaceOrientation.unknown
    ] {
      XCTAssertEqual(
        CoordinateSpaceRotation.native(
          point: CGPoint(x: 578, y: 239),
          in: windowOnScreen,
          interfaceOrientation: orientation
        ),
        CGPoint(x: 578, y: 239),
        "interfaceOrientation \(orientation)"
      )
    }
    // A turn moves axes only: the same point under a landscape window keeps its own origin story.
    XCTAssertEqual(
      CoordinateSpaceRotation.native(
        point: CGPoint(x: 578, y: 239),
        in: windowOnScreen,
        interfaceOrientation: RunnerInterfaceOrientation.landscapeRight
      ),
      CGPoint(x: 682 - 239, y: 578)
    )
  }

  func testNormalizedOfAnEmptyArrayIsEmpty() {
    XCTAssertEqual(
      SnapshotGeometrySpace.normalized(
        nodes: [],
        viewport: .reported(
          box: CGRect(x: 0, y: 0, width: 874, height: 402),
          interfaceOrientation: RunnerInterfaceOrientation.landscapeRight
        )
      ),
      []
    )
  }

}
