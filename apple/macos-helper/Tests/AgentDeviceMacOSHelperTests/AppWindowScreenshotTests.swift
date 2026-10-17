import CoreGraphics
import XCTest

@testable import AgentDeviceMacOSHelper

private struct Candidate: Equatable {
  let id: Int
  let area: Double
}

/// An app screenshot captures the front window or refuses; it never substitutes another window.
final class AppWindowScreenshotTests: XCTestCase {
  func testCaptureIdentityAndScrollAndClickFallbackFrameSelectTheSameEligibleFrontWindow() throws {
    let windows = [
      windowInfo(id: 1, pid: 99),
      windowInfo(id: 2, layer: 1),
      windowInfo(id: 3, onScreen: false),
      windowInfo(id: 4, alpha: 0),
      windowInfo(id: 5, width: 0),
      windowInfo(id: 6, height: 0),
      windowInfo(id: 7, alpha: 0.5, width: 20, height: 20),
      windowInfo(id: 8),
    ]

    let front = try frontWindow(pid: 42, windowInfo: windows)
    let selected = frontShareableWindow([7, 8], front: front, windowID: { $0 })

    // Scroll and the click actionWindow fallback both consume frontWindowFrame.
    XCTAssertEqual(
      try frontWindowFrame(pid: 42, windowInfo: windows),
      CGRect(x: 10, y: 10, width: 20, height: 20))
    XCTAssertEqual(front?.number, 7)
    XCTAssertEqual(try selected.get(), 7)
  }

  func testSkipsAppModalAlertInFrontOfNormalLayerWindow() throws {
    let windows = [windowInfo(id: 8, layer: 8), windowInfo(id: 3)]
    let front = try frontWindow(pid: 42, windowInfo: windows)
    let selected = frontShareableWindow([8, 3], front: front, windowID: { $0 })

    XCTAssertEqual(front?.number, 3)
    XCTAssertEqual(try selected.get(), 3)
    XCTAssertEqual(try frontWindowFrame(pid: 42, windowInfo: windows), front?.bounds)
  }

  func testRefusesWhenOnlyInvisibleOrEmptyWindowsRemain() throws {
    let windows = [
      windowInfo(id: 1, onScreen: false),
      windowInfo(id: 2, alpha: 0),
      windowInfo(id: 3, width: 0),
      windowInfo(id: 4, height: 0),
    ]
    let front = try frontWindow(pid: 42, windowInfo: windows)
    let selected = frontShareableWindow([5], front: front, windowID: { $0 })

    XCTAssertNil(try frontWindowFrame(pid: 42, windowInfo: windows))
    XCTAssertNil(front)
    XCTAssertThrowsError(try selected.get()) { error in
      assertRefusal(error, reason: "window-not-found", hint: "Open or unminimize")
    }
  }

  func testUnreadableWindowListRefusesBeforeCaptureOrScrollCanReportNoWindow() {
    XCTAssertThrowsError(try frontWindow(pid: 42, windowInfo: nil)) { error in
      assertUnreadableList(error)
    }
    XCTAssertThrowsError(try frontWindowFrame(pid: 42, windowInfo: nil)) { error in
      assertUnreadableList(error)
    }
    XCTAssertNil(try frontWindow(pid: 42, windowInfo: []))
    XCTAssertNil(try frontWindowFrame(pid: 42, windowInfo: []))
  }

  func testSelectsTheFrontWindowEvenWhenAnotherIsLarger() {
    let candidates = [Candidate(id: 7, area: 10_000), Candidate(id: 3, area: 100)]

    let selected = frontShareableWindow(candidates, front: onScreenWindow(id: 3), windowID: \.id)

    XCTAssertEqual(try selected.get(), Candidate(id: 3, area: 100))
  }

  func testRefusesWhenTheFrontWindowIsNotShareable() {
    let candidates = [Candidate(id: 7, area: 10_000), Candidate(id: 8, area: 100)]

    let selected = frontShareableWindow(candidates, front: onScreenWindow(id: 3), windowID: \.id)

    XCTAssertThrowsError(try selected.get()) { error in
      assertRefusal(
        error,
        reason: "front-window-not-shareable",
        hint: "retry after it settles",
        frontWindowId: "3")
    }
  }

  func testCaptureExclusionSurvivesWindowSelectionAndNeverSubstitutesAnotherWindow() throws {
    let windows = [windowInfo(id: 3, sharingState: 0), windowInfo(id: 7)]
    let front = try frontWindow(pid: 42, windowInfo: windows)
    XCTAssertEqual(front?.number, 3)
    XCTAssertEqual(front?.sharingState, 0)

    for candidates in [[3, 7], [7]] {
      let selected = frontShareableWindow(candidates, front: front, windowID: { $0 })
      XCTAssertThrowsError(try selected.get()) { error in
        assertRefusal(
          error,
          reason: "front-window-capture-excluded",
          hint: "Run `snapshot` to read the window",
          frontWindowId: "3")
      }
    }

    var entry = windowInfo(id: 3)
    entry.removeValue(forKey: kCGWindowSharingState as String)
    let unknown = try frontWindow(pid: 42, windowInfo: [entry])
    let selected = frontShareableWindow([3], front: unknown, windowID: { $0 })
    XCTAssertEqual(try selected.get(), 3)
  }

  func testRefusesWhenTheAppHasNoOnScreenWindow() {
    let selected = frontShareableWindow(
      [Candidate(id: 7, area: 10_000)], front: nil, windowID: \.id)

    XCTAssertThrowsError(try selected.get()) { error in
      assertRefusal(error, reason: "window-not-found", hint: "Open or unminimize")
    }
  }
}

/// The refusal carries the reason and the remedy the agent runs next, alongside the front window
/// it refused.
private func assertRefusal(
  _ error: Error,
  reason: String,
  hint: String,
  frontWindowId: String? = nil,
  file: StaticString = #filePath,
  line: UInt = #line
) {
  guard let refusal = error as? AppWindowScreenshotRefusal else {
    return XCTFail("expected an AppWindowScreenshotRefusal, got \(error)", file: file, line: line)
  }
  guard
    case HelperError.commandFailed(_, let details) = refusal.error(
      bundleId: "com.apple.TextEdit")
  else {
    return XCTFail("expected a commandFailed refusal error", file: file, line: line)
  }
  XCTAssertEqual(details["reason"], reason, file: file, line: line)
  XCTAssertEqual(details["bundleId"], "com.apple.TextEdit", file: file, line: line)
  XCTAssertEqual(details["frontWindowId"], frontWindowId, file: file, line: line)
  XCTAssertTrue(
    (details["hint"] ?? "").contains(hint),
    "hint \(details["hint"] ?? "<nil>") lacks \(hint)",
    file: file, line: line)
}

private func assertUnreadableList(
  _ error: Error, file: StaticString = #filePath, line: UInt = #line
) {
  guard case HelperError.commandFailed(_, let details) = error else {
    return XCTFail("expected a typed window-list refusal, got \(error)", file: file, line: line)
  }
  XCTAssertEqual(details["reason"], "window-list-unreadable", file: file, line: line)
  XCTAssertEqual(
    details["hint"],
    "The app's on-screen window list could not be read. Retry the command.",
    file: file, line: line)
}

private func onScreenWindow(id: Int) -> OnScreenWindow {
  OnScreenWindow(number: id, bounds: .zero, sharingState: 1)
}

private func windowInfo(
  id: Int, pid: Int32 = 42, layer: Int = 0, onScreen: Bool = true,
  alpha: Double = 1, sharingState: Int = 1, width: Double = 100, height: Double = 100
) -> [String: Any] {
  [
    kCGWindowNumber as String: id,
    kCGWindowOwnerPID as String: pid,
    kCGWindowLayer as String: layer,
    kCGWindowIsOnscreen as String: onScreen,
    kCGWindowAlpha as String: alpha,
    kCGWindowSharingState as String: sharingState,
    kCGWindowBounds as String: CGRect(x: 10, y: 10, width: width, height: height).dictionaryRepresentation,
  ]
}
