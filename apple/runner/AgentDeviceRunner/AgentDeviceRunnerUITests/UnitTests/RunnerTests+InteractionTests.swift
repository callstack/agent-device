import XCTest
import AgentDeviceSnapshotPresentation

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
extension RunnerTests {
  func testDesktopScrollWheelDeltasMapDirections() {
    XCTAssertEqual(desktopScrollWheelDeltas(direction: .up, pixels: 120).vertical, 120)
    XCTAssertEqual(desktopScrollWheelDeltas(direction: .down, pixels: 120).vertical, -120)
    XCTAssertEqual(desktopScrollWheelDeltas(direction: .left, pixels: 120).horizontal, 120)
    XCTAssertEqual(desktopScrollWheelDeltas(direction: .right, pixels: 120).horizontal, -120)
  }

  func testDesktopScrollWheelDeltaEventsHonorDurationAndPreservePixels() {
    let events = desktopScrollWheelDeltaEvents(direction: .down, pixels: 200, durationMs: 50)
    XCTAssertEqual(events.count, 4)
    XCTAssertEqual(events.map(\.vertical).reduce(0, +), -200)
    XCTAssertEqual(events.map(\.horizontal).reduce(0, +), 0)
    XCTAssertEqual(desktopScrollEventIntervalSeconds(durationMs: 50, eventCount: events.count), 0.05 / 3.0)
  }

  func testDesktopScrollWheelDeltaEventsKeepInstantScrollSingleEvent() {
    let events = desktopScrollWheelDeltaEvents(direction: .down, pixels: 200, durationMs: 0)
    XCTAssertEqual(events.count, 1)
    XCTAssertEqual(events.first?.vertical, -200)
  }

  func testFindTextPredicateMatchesWaitTextGoldenTable() throws {
    struct Case: Decodable {
      struct Node: Decodable {
        let editable: Bool?
        let enabled: Bool?
        let label: String?
        let value: String?
        let identifier: String?
        let placeholder: String?
      }
      let name: String
      let platform: String?
      let text: String
      let node: Node
      let expected: Bool
    }
    let fixtureURL = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent() // UnitTests
      .deletingLastPathComponent() // AgentDeviceRunnerUITests
      .deletingLastPathComponent() // AgentDeviceRunner
      .deletingLastPathComponent() // runner
      .deletingLastPathComponent() // apple
      .deletingLastPathComponent() // repo root
      .appendingPathComponent("contracts/fixtures/wait-text-policy.json")
    let cases = try JSONDecoder().decode([Case].self, from: Data(contentsOf: fixtureURL))
    XCTAssertFalse(cases.isEmpty, "wait text policy table must not be empty")

    let editableTypes: [XCUIElement.ElementType] = [.textField, .secureTextField, .searchField, .textView]
    // Android and web rows pin the TS twin; the runner sees Apple element types only.
    for fixture in cases where fixture.platform == nil {
      for type in fixture.node.editable == true ? editableTypes : [.staticText, .other] {
        var attributes: [String: Any] = [
          "elementType": type.rawValue,
          "enabled": fixture.node.enabled ?? true,
        ]
        attributes["label"] = fixture.node.label
        attributes["value"] = fixture.node.value
        attributes["identifier"] = fixture.node.identifier
        attributes["placeholderValue"] = fixture.node.placeholder
        XCTAssertEqual(
          Self.findTextPredicate(fixture.text).evaluate(with: attributes),
          fixture.expected,
          "\(fixture.name) (elementType \(type.rawValue))"
        )
      }
    }
  }
}
#endif

#if AGENT_DEVICE_RUNNER_UNIT_TESTS && os(iOS)
  import ObjectiveC.runtime

  /// Answers `-[XCUIElement frame]` from a plan while counting the reads, so a test decides which
  /// candidates the runtime refuses and the only variable left is how many windows the resolver asked
  /// about. Installed for the duration of one test, which serial XCTest execution tolerates; the same
  /// `method_setImplementation` technique the snapshot-plan lane uses for
  /// `-[XCUIElement snapshotWithError:]`.
  private enum RunnerWindowFrameReads {
    static let usableFrame = CGRect(x: 0, y: 0, width: 402, height: 874)
    private static let lock = NSLock()
    private static var count = 0
    private static var answers: [CGRect] = []

    /// Answers the Nth read from `answers`, repeating the last one beyond its end, so every window the
    /// app reports has a reply waiting and the read count is the resolver's choice alone. A `.zero`
    /// entry is what an unmeasured window answers — `(0,0 0x0)` without raising (ADR 0025).
    static func begin(answering answers: [CGRect]) {
      lock.lock()
      count = 0
      RunnerWindowFrameReads.answers = answers
      lock.unlock()
    }

    static func recorded() -> Int {
      lock.lock()
      defer { lock.unlock() }
      return count
    }

    static func answerNextRead() -> CGRect {
      lock.lock()
      let index = count
      count += 1
      let answer = index < answers.count ? answers[index] : (answers.last ?? .zero)
      lock.unlock()
      return answer
    }
  }

  private final class RunnerWindowFrameProbe: NSObject {
    @objc var frame: CGRect {
      RunnerWindowFrameReads.answerNextRead()
    }
  }

  extension RunnerTests {
    @MainActor
    func testRunnerWindowResolutionReadsOnlyThroughTheFirstUsableWindow() throws {
      app.launchArguments = ["--agent-device-second-window"]
      app.launch()
      defer {
        invalidateCachedTarget(reason: "unit_test_cleanup")
        app.terminate()
      }
      XCTAssertTrue(app.waitForFixtureExistence(timeout: appExistenceTimeout))
      XCTAssertEqual(
        app.windows.allElementsBoundByIndex.filter(\.exists).count,
        2,
        "the fixture must leave two live windows, or no candidate is left behind the answer"
      )

      let cases: [(name: String, frames: [CGRect], hasWindow: Bool, reads: Int)] = [
        ("first usable window", [RunnerWindowFrameReads.usableFrame], true, 1),
        ("empty first window", [.zero, RunnerWindowFrameReads.usableFrame], true, 2),
        ("all windows empty", [.zero], false, 3)
      ]
      for testCase in cases {
        RunnerWindowFrameReads.begin(answering: testCase.frames)
        let resolved = try withWindowFrameProbe { try resolveRunnerWindow(app: app) }
        XCTAssertEqual(resolved.window != nil, testCase.hasWindow, testCase.name)
        XCTAssertEqual(RunnerWindowFrameReads.recorded(), testCase.reads, testCase.name)
        XCTAssertEqual(
          resolved.frame,
          testCase.hasWindow ? RunnerWindowFrameReads.usableFrame : .zero,
          testCase.name
        )
      }
    }

    /// Runs `body` with `-[XCUIElement frame]` answered by `RunnerWindowFrameProbe`, then restores XCTest.
    private func withWindowFrameProbe<Result>(_ body: () throws -> Result) throws -> Result {
      let frameMethod = try XCTUnwrap(
        class_getInstanceMethod(XCUIElement.self, #selector(getter: XCUIElement.frame)),
        "unable to install the window frame probe"
      )
      let probeMethod = try XCTUnwrap(
        class_getInstanceMethod(RunnerWindowFrameProbe.self, #selector(getter: RunnerWindowFrameProbe.frame)),
        "unable to install the window frame probe"
      )
      let originalImplementation = method_setImplementation(frameMethod, method_getImplementation(probeMethod))
      defer { method_setImplementation(frameMethod, originalImplementation) }
      return try body()
    }

    /// A full-screen app's capture takes its viewport from the root snapshot it already holds. Each
    /// live window read resolves `app.windows` against a fresh snapshot of the whole app: on a heavy
    /// web view the list, `exists`, and `frame` reads took 7.4 s together, outlasted the viewport's
    /// 1 s slice, and left work that refused the next tap with `RUNNER_BUSY`.
    @MainActor
    func testFullScreenSnapshotViewportReadsTheWindowFromTheRootSnapshot() throws {
      app.launch()
      defer {
        invalidateCachedTarget(reason: "unit_test_cleanup")
        app.terminate()
      }
      XCTAssertTrue(app.waitForFixtureExistence(timeout: appExistenceTimeout))
      let appWindows = app.windows.allElementsBoundByIndex.filter(\.exists).map(\.frame)
      let fullScreenWindow = Self.fullScreenWindowFrame(windowFrames: appWindows, fullScreenFrame: Self.fullScreenFrame(of: app) { MainActor.assumeIsolated { self.commandSoleScreenSize() } })
      // An iPad can place the fixture's window, which keeps the live read; an iPhone app always fills
      // the screen, so there a nil predicate is a failure, not a skip.
      try XCTSkipIf(
        fullScreenWindow == nil && UIDevice.current.userInterfaceIdiom == .pad,
        "the fixture app's window is not the full screen at the origin on this iPad"
      )
      _ = try XCTUnwrap(fullScreenWindow, "the fixture app's window is not the full screen at the origin")
      let hint = CaptureHint(
        projection: .regular,
        depth: nil,
        regularPresentedDepth: nil,
        interactiveOnly: false,
        customActions: false
      )
      RunnerWindowFrameReads.begin(answering: [RunnerWindowFrameReads.usableFrame.insetBy(dx: 10, dy: 10)])
      let context = try XCTUnwrap(try withWindowFrameProbe { try makeSnapshotTraversalContext(app: app, hint: hint) })

      let window = try XCTUnwrap(context.rootSnapshot.children.first { $0.elementType == .window })
      XCTAssertEqual(RunnerWindowFrameReads.recorded(), 0)
      XCTAssertEqual(
        context.viewport,
        .reported(box: window.frame, interfaceOrientation: capturedInterfaceOrientation(app: app))
      )
    }
  }
#endif

#if AGENT_DEVICE_RUNNER_UNIT_TESTS && os(iOS)
  /// Answers the application's own frame and leaves every other element to XCTest. With no
  /// `recordingTest` the application reads `appFrame`; with one, the read records the issue XCTest
  /// records when it cannot snapshot the application and leaves a null frame.
  private final class RunnerApplicationFrameProbe: NSObject {
    static var originalFrame: IMP?
    static var appFrame = CGRect.zero
    static weak var recordingTest: XCTestCase?
    @objc var frame: CGRect {
      if object_getClass(self).map({ $0.isSubclass(of: XCUIApplication.self) }) == true {
        guard let recordingTest = Self.recordingTest else { return Self.appFrame }
        recordingTest.record(
          XCTIssue(type: .assertionFailure, compactDescription: "No element snapshot found for Application 'stub'")
        )
        return .null
      }
      typealias Getter = @convention(c) (AnyObject, Selector) -> CGRect
      return unsafeBitCast(Self.originalFrame!, to: Getter.self)(self, #selector(getter: XCUIElement.frame))
    }
    @objc var isHittable: Bool { false }
  }

  extension RunnerTests {
    /// Installs `RunnerApplicationFrameProbe` (and, when asked, its non-hittable answer) until the
    /// returned closure restores XCTest.
    private func probeApplicationFrame(nonHittable: Bool = false) throws -> () -> Void {
      var selectors = [#selector(getter: XCUIElement.frame)]
      if nonHittable { selectors.append(#selector(getter: XCUIElement.isHittable)) }
      let swaps = try selectors.map { selector in
        (try XCTUnwrap(class_getInstanceMethod(XCUIElement.self, selector)),
         try XCTUnwrap(class_getInstanceMethod(RunnerApplicationFrameProbe.self, selector)))
      }
      RunnerApplicationFrameProbe.originalFrame = method_getImplementation(swaps[0].0)
      let originals = swaps.map { ($0.0, method_setImplementation($0.0, method_getImplementation($0.1))) }
      return {
        for (method, original) in originals.reversed() { method_setImplementation(method, original) }
        RunnerApplicationFrameProbe.recordingTest = nil
        RunnerApplicationFrameProbe.appFrame = .zero
      }
    }

    /// A readable window with an empty application frame keeps the touch frame anchored at the
    /// window: only a frame that does not read refuses, not one that reads empty.
    @MainActor
    func testTouchFrameWithAReadableWindowAndAnEmptyAppFrameAnchorsAtTheWindow() throws {
      app.launch()
      defer {
        invalidateCachedTarget(reason: "unit_test_cleanup")
        app.terminate()
      }
      let window = try XCTUnwrap(resolveRunnerWindowElement(app: app))
      let restore = try probeApplicationFrame()
      defer { restore() }

      let frame = try resolvedTouchVisualizationFrame(app: app, x: 20, y: 30)

      XCTAssertEqual(frame.x, Double(window.frame.minX) + 20)
      XCTAssertEqual(frame.y, Double(window.frame.minY) + 30)
      XCTAssertEqual(frame.referenceWidth, Double(window.frame.width))
    }

    /// The non-hittable coordinate fallback measures a match against the application frame. On a
    /// tree XCTest cannot snapshot that read is held and refuses with the coded refusal, so the
    /// selector match records no issue.
    @MainActor
    func testNonHittableFallbackMatchOnAnUnreadableAppFrameRefusesWithoutARecordedIssue() throws {
      app.launch()
      defer {
        invalidateCachedTarget(reason: "unit_test_cleanup")
        app.terminate()
      }
      let label = try XCTUnwrap(
        app.descendants(matching: .any).allElementsBoundByIndex.lazy
          .filter { $0.elementType != .application }.map(\.label).first { !$0.isEmpty },
        "the fixture must show a labeled element"
      )
      let restore = try probeApplicationFrame(nonHittable: true)
      defer { restore() }
      RunnerApplicationFrameProbe.recordingTest = self
      let failureCountBefore = currentXCTestFailureCount()

      XCTAssertThrowsError(
        try findElement(app: app, selectorKey: "label", selectorValue: label, allowNonHittableFallback: true)
      ) { XCTAssertTrue($0 is RunnerCoordinateRefusal, "\($0)") }

      XCTAssertFalse(didRecordXCTestFailure(since: failureCountBefore))
    }
  }
#endif
