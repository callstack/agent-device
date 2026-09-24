import Foundation
import XCTest

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
extension RunnerTests {
  func testErrorPayloadEncodesEveryFieldButTheRunnerInternalRetryableFailure() throws {
    let payload = ErrorPayload(
      code: "CODE",
      message: "message",
      hint: "hint",
      retryableFailure: .targetAppUnavailable
    )
    let encoded = try JSONEncoder().encode(payload)
    let object = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
    let storedFields = Set(Mirror(reflecting: payload).children.compactMap(\.label))
    XCTAssertEqual(Set(object.keys), storedFields.subtracting(["retryableFailure"]))
  }

  func testTargetAppUnavailableErrorKeepsItsWireShape() throws {
    let encoded = try JSONEncoder().encode(
      ErrorPayload.targetAppUnavailable(bundleId: "com.example.app")
    )
    let object = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
    XCTAssertEqual(Array(object.keys), ["message"])
    XCTAssertEqual(object["message"] as? String, "app 'com.example.app' is not available")
    XCTAssertEqual(
      ErrorPayload.targetAppUnavailable(bundleId: nil).message,
      "runner app is not available"
    )
  }

  func runnerCommandFixture(_ json: String) throws -> Command {
    try JSONDecoder().decode(Command.self, from: Data(json.utf8))
  }

  /// One row's expectation, as literals. It deliberately does not build a `CommandTraits`: an
  /// expectation constructed by the type under test moves with it, so a declaration that swapped or
  /// rewrote a fact would keep such a row green. Each fact is compared below against its own
  /// literal, and the named groups the classification resolves through are file-private to it
  /// (#2890 review).
  private struct ExpectedTraits {
    let isInteraction: Bool
    let retryOnSessionLoss: Bool
    let launchPolicy: CommandLaunchPolicy
    let convertsRecordedFailure: Bool
  }

  private func expectation(
    interaction: Bool,
    retry: Bool,
    launch: CommandLaunchPolicy,
    converts: Bool
  ) -> ExpectedTraits {
    ExpectedTraits(
      isInteraction: interaction,
      retryOnSessionLoss: retry,
      launchPolicy: launch,
      convertsRecordedFailure: converts
    )
  }

  private func assertTraits(
    _ traits: CommandTraits,
    matches expectation: ExpectedTraits,
    _ request: String
  ) {
    XCTAssertEqual(traits.isInteraction, expectation.isInteraction, "\(request) isInteraction")
    XCTAssertEqual(
      traits.retryOnSessionLoss,
      expectation.retryOnSessionLoss,
      "\(request) retryOnSessionLoss"
    )
    XCTAssertEqual(traits.launchPolicy, expectation.launchPolicy, "\(request) launchPolicy")
    XCTAssertEqual(
      traits.convertsRecordedFailure,
      expectation.convertsRecordedFailure,
      "\(request) convertsRecordedFailure"
    )
  }

  /// Every decision the runner makes from a classification, asserted for every command from one
  /// table. `retry` is replay eligibility and `launch` is what the runner may do about a stopped
  /// app: `querySelector` is the row that proves one does not set the other (#2890). Each row names
  /// a concrete launch case, so re-pointing a command at another policy fails that row.
  func testEveryCommandDeclaresEveryRunnerSideDecisionTogether() throws {
    let table: [(CommandType, ExpectedTraits)] = [
      (.tap, expectation(interaction: true, retry: false, launch: .mayLaunch, converts: true)),
      (.mouseClick, expectation(interaction: false, retry: false, launch: .mayLaunch, converts: true)),
      (.longPress, expectation(interaction: true, retry: false, launch: .mayLaunch, converts: true)),
      (.drag, expectation(interaction: true, retry: false, launch: .mayLaunch, converts: true)),
      (.remotePress, expectation(interaction: true, retry: false, launch: .mayLaunch, converts: true)),
      (.type, expectation(interaction: true, retry: false, launch: .mayLaunch, converts: true)),
      (.swipe, expectation(interaction: true, retry: false, launch: .mayLaunch, converts: true)),
      (.scroll, expectation(interaction: true, retry: false, launch: .mayLaunch, converts: true)),
      (.desktopScroll, expectation(interaction: true, retry: false, launch: .mayLaunch, converts: true)),
      (.findText, expectation(interaction: false, retry: true, launch: .existingApp, converts: false)),
      (
        .querySelector,
        expectation(interaction: false, retry: false, launch: .existingApp, converts: true)
      ),
      (.readText, expectation(interaction: false, retry: true, launch: .existingApp, converts: false)),
      (.snapshot, expectation(interaction: false, retry: true, launch: .existingApp, converts: false)),
      (.screenshot, expectation(interaction: false, retry: true, launch: .noApp, converts: false)),
      (.backInApp, expectation(interaction: true, retry: false, launch: .mayLaunch, converts: true)),
      (.backSystem, expectation(interaction: true, retry: false, launch: .mayLaunch, converts: true)),
      (.home, expectation(interaction: false, retry: false, launch: .mayLaunch, converts: true)),
      (.rotate, expectation(interaction: true, retry: false, launch: .mayLaunch, converts: true)),
      (.appSwitcher, expectation(interaction: true, retry: false, launch: .mayLaunch, converts: true)),
      (
        .actionButton,
        expectation(interaction: false, retry: false, launch: .presentedSurface, converts: true)
      ),
      (.keyboardDismiss, expectation(interaction: true, retry: false, launch: .mayLaunch, converts: true)),
      (.keyboardReturn, expectation(interaction: true, retry: false, launch: .mayLaunch, converts: true)),
      (
        .alert,
        expectation(interaction: false, retry: true, launch: .presentedSurface, converts: false)
      ),
      (.sequence, expectation(interaction: true, retry: false, launch: .mayLaunch, converts: true)),
      (.gesture, expectation(interaction: true, retry: false, launch: .mayLaunch, converts: true)),
      (
        .gestureViewport,
        expectation(interaction: false, retry: true, launch: .existingApp, converts: false)
      ),
      (.recordStart, expectation(interaction: false, retry: false, launch: .mayLaunch, converts: true)),
      (.recordStop, expectation(interaction: false, retry: false, launch: .noApp, converts: false)),
      (.status, expectation(interaction: false, retry: true, launch: .noApp, converts: false)),
      (.uptime, expectation(interaction: false, retry: false, launch: .noApp, converts: false)),
      (.activate, expectation(interaction: false, retry: false, launch: .mayLaunch, converts: true)),
      (.terminate, expectation(interaction: false, retry: false, launch: .noApp, converts: false)),
      (.targetReset, expectation(interaction: false, retry: false, launch: .noApp, converts: false)),
      (.shutdown, expectation(interaction: false, retry: false, launch: .noApp, converts: false))
    ]
    for (type, rowExpectation) in table {
      let request = #"{"command":"\#(type.rawValue)"}"#
      let command = try runnerCommandFixture(request)
      XCTAssertEqual(command.command, type, request)
      assertTraits(command.traits, matches: rowExpectation, request)
    }
    XCTAssertEqual(
      Set(table.map { $0.0 }),
      Set(CommandType.allCases),
      "every command states its decisions in this table"
    )

    // The one payload-dependent command settles each fact per action: `get` changes nothing and may
    // be replayed, while `accept` and `dismiss` mutate and must not be.
    let alertCases: [(action: String?, expectation: ExpectedTraits)] = [
      (nil, expectation(interaction: false, retry: true, launch: .presentedSurface, converts: false)),
      ("get", expectation(interaction: false, retry: true, launch: .presentedSurface, converts: false)),
      (
        "accept",
        expectation(interaction: false, retry: false, launch: .presentedSurface, converts: true)
      ),
      (
        "dismiss",
        expectation(interaction: false, retry: false, launch: .presentedSurface, converts: true)
      )
    ]
    for alertCase in alertCases {
      let request = alertCase.action.map { #"{"command":"alert","action":"\#($0)"}"# }
        ?? #"{"command":"alert"}"#
      assertTraits(try runnerCommandFixture(request).traits, matches: alertCase.expectation, request)
    }
  }
}
#endif
