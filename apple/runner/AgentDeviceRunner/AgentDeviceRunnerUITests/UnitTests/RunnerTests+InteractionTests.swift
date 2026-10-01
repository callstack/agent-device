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
    /// #2995: resolving a window must read the window it books and nothing behind it. Reads are
    /// counted rather than matched by identity because which window `XCUIApplication.windows` reports
    /// first is XCTest's to choose; the property is that the first answer is the last read.
    @MainActor
    func testRunnerWindowResolutionStopsReadingAtTheWindowItChose() throws {
      let outcome = try resolveRunnerWindowAgainstTwoWindows(
        answering: [RunnerWindowFrameReads.usableFrame]
      )
      XCTAssertNotNil(outcome.resolved.window, "an app with two usable windows resolves one of them")
      XCTAssertEqual(outcome.reads, 1, "a window behind the chosen one was read")
    }

    /// The closest negative, so the single read above cannot pass because the resolver never looked at
    /// a second window at all: when the first candidate reports no frame, the second one must be asked.
    @MainActor
    func testRunnerWindowResolutionKeepsLookingPastAWindowWithNoFrame() throws {
      let outcome = try resolveRunnerWindowAgainstTwoWindows(
        answering: [.zero, RunnerWindowFrameReads.usableFrame]
      )
      XCTAssertNotNil(
        outcome.resolved.window,
        "the second window qualifies, so the resolver owes a window rather than app.frame"
      )
      XCTAssertEqual(outcome.reads, 2, "a refused first window costs the second window its read")
    }

    /// The other half of stopping early: when no candidate qualifies, the walk must still have asked
    /// every one of them, and it must refuse a window rather than book a zero rectangle to normalize
    /// against.
    @MainActor
    func testRunnerWindowResolutionRefusesAWindowWhenEveryCandidateMeasuresZero() throws {
      let outcome = try resolveRunnerWindowAgainstTwoWindows(answering: [.zero])
      XCTAssertNil(outcome.resolved.window, "no candidate qualifies, so no window is booked against")
      XCTAssertEqual(
        outcome.reads,
        3,
        "the walk gives up only after asking both windows, and the fallback's own app.frame read is the third"
      )
      // `XCUIApplication` declares no `frame` of its own, so the third read is the same swizzled
      // `XCUIElement` getter and the fallback frame is the probe's answer. A real app frame here would
      // mean the fallback reads geometry the probe never saw.
      XCTAssertEqual(
        outcome.resolved.frame,
        .zero,
        "the app.frame fallback goes through the same read as a window's"
      )
    }

    /// Launches the two-window fixture, installs the frame probe answering `frames` in read order
    /// (repeating its last answer), and resolves once.
    @MainActor
    private func resolveRunnerWindowAgainstTwoWindows(
      answering frames: [CGRect]
    ) throws -> (resolved: (window: XCUIElement?, frame: CGRect), reads: Int) {
      app.launchArguments = ["--agent-device-second-window"]
      app.launch()
      defer {
        invalidateCachedTarget(reason: "unit_test_cleanup")
        app.terminate()
      }
      XCTAssertTrue(app.waitForExistence(timeout: appExistenceTimeout))
      XCTAssertEqual(
        app.windows.allElementsBoundByIndex.filter(\.exists).count,
        2,
        "the fixture must leave two live windows, or no candidate is left behind the answer"
      )

      guard
        let frameMethod = class_getInstanceMethod(XCUIElement.self, #selector(getter: XCUIElement.frame)),
        let probeMethod = class_getInstanceMethod(
          RunnerWindowFrameProbe.self,
          #selector(getter: RunnerWindowFrameProbe.frame)
        )
      else {
        XCTFail("unable to install the window frame probe")
        return ((nil, .zero), 0)
      }
      RunnerWindowFrameReads.begin(answering: frames)
      let originalImplementation = method_getImplementation(frameMethod)
      method_setImplementation(frameMethod, method_getImplementation(probeMethod))
      defer { method_setImplementation(frameMethod, originalImplementation) }

      return (resolveRunnerWindow(app: app), RunnerWindowFrameReads.recorded())
    }
  }
#endif
