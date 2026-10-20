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

      guard
        let frameMethod = class_getInstanceMethod(XCUIElement.self, #selector(getter: XCUIElement.frame)),
        let probeMethod = class_getInstanceMethod(
          RunnerWindowFrameProbe.self,
          #selector(getter: RunnerWindowFrameProbe.frame)
        )
      else {
        XCTFail("unable to install the window frame probe")
        return
      }
      let originalImplementation = method_getImplementation(frameMethod)
      method_setImplementation(frameMethod, method_getImplementation(probeMethod))
      defer { method_setImplementation(frameMethod, originalImplementation) }

      let cases: [(name: String, frames: [CGRect], hasWindow: Bool, reads: Int)] = [
        ("first usable window", [RunnerWindowFrameReads.usableFrame], true, 1),
        ("empty first window", [.zero, RunnerWindowFrameReads.usableFrame], true, 2),
        ("all windows empty", [.zero], false, 3)
      ]
      for testCase in cases {
        RunnerWindowFrameReads.begin(answering: testCase.frames)
        let resolved = resolveRunnerWindow(app: app)
        XCTAssertEqual(resolved.window != nil, testCase.hasWindow, testCase.name)
        XCTAssertEqual(RunnerWindowFrameReads.recorded(), testCase.reads, testCase.name)
        XCTAssertEqual(
          resolved.frame,
          testCase.hasWindow ? RunnerWindowFrameReads.usableFrame : .zero,
          testCase.name
        )
      }
    }
  }
#endif
