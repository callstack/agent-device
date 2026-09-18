import AgentDeviceSnapshotPresentation
import CoreGraphics
import Foundation
import XCTest

/// The rotation table and the space a captured window declares (#2612). Pure geometry: it runs here,
/// without a simulator, and the runner's walkers are tested separately for threading it through.
final class CoordinateSpaceTests: XCTestCase {
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
          isWindow: false,
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

  /// Golden parity table (#2612): every case in contracts/fixtures/window-coordinate-space.json
  /// must agree with the vitest twin
  /// (packages/platform-apple/src/snapshot-source/window-coordinate-space.test.ts). Add
  /// cases there, never fork the rule. Detection is replayed under both landscape turns, because
  /// which window declares the native space cannot depend on which way the app is turned; the
  /// rotation rows carry their own orientation.
  func testWindowCoordinateSpaceMatchesGoldenParityTable() throws {
    let fixture = try loadWindowCoordinateSpaceFixture()
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

  private func loadWindowCoordinateSpaceFixture() throws -> WindowCoordinateSpaceFixture {
    let fixtureURL = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent() // AgentDeviceSnapshotPresentationTests
      .deletingLastPathComponent() // Tests
      .deletingLastPathComponent() // snapshot-presentation
      .deletingLastPathComponent() // apple
      .deletingLastPathComponent() // repo root
      .appendingPathComponent("contracts")
      .appendingPathComponent("fixtures")
      .appendingPathComponent("window-coordinate-space.json")
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
        viewport: app,
        interfaceOrientation: testCase.interfaceOrientation
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
      viewport: app,
      interfaceOrientation: RunnerInterfaceOrientation.landscapeRight
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
      viewport: app,
      interfaceOrientation: RunnerInterfaceOrientation.unknown
    )
    XCTAssertEqual(normalized.map(\.rect), acquired.map(\.rect))
    XCTAssertEqual(normalized[1].hittable, true)
    XCTAssertEqual(normalized[2].hittable, false)
    XCTAssertEqual(normalized[0].hittable, false)
  }

  func testNormalizedOfAnEmptyArrayIsEmpty() {
    XCTAssertEqual(
      SnapshotGeometrySpace.normalized(
        nodes: [],
        viewport: CGRect(x: 0, y: 0, width: 874, height: 402),
        interfaceOrientation: RunnerInterfaceOrientation.landscapeRight
      ),
      []
    )
  }

}
