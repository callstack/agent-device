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

  /// The five decisions `CommandType.traits(for:)` declares, in declaration order.
  private func traits(
    _ interaction: Bool,
    _ retry: Bool,
    _ launch: CommandLaunchPolicy,
    _ converts: Bool,
    _ clears: Bool
  ) -> CommandTraits {
    CommandTraits(
      isInteraction: interaction,
      retryOnSessionLoss: retry,
      launchPolicy: launch,
      convertsRecordedFailure: converts,
      clearsRememberedTextEntryTap: clears
    )
  }

  /// Every decision the runner makes from a classification, asserted for every command from one
  /// table. `retry` is replay eligibility and `launch` is what the runner may do about a stopped
  /// app: `querySelector` is the row that proves one does not set the other (#2890).
  func testEveryCommandDeclaresEveryRunnerSideDecisionTogether() throws {
    //   command          interaction retry  launch        converts clears
    let table: [(CommandType, Bool, Bool, CommandLaunchPolicy, Bool, Bool)] = [
      (.tap,              true,  false, .mayLaunch,   true,  false),
      (.mouseClick,       false, false, .mayLaunch,   true,  true),
      (.longPress,        true,  false, .mayLaunch,   true,  true),
      (.drag,             true,  false, .mayLaunch,   true,  true),
      (.remotePress,      true,  false, .mayLaunch,   true,  true),
      (.type,             true,  false, .mayLaunch,   true,  false),
      (.swipe,            true,  false, .mayLaunch,   true,  true),
      (.scroll,           true,  false, .mayLaunch,   true,  true),
      (.desktopScroll,    true,  false, .mayLaunch,   true,  true),
      (.findText,         false, true,  .existingApp, false, false),
      (.querySelector,    false, false, .existingApp, true,  true),
      (.readText,         false, true,  .existingApp, false, false),
      (.snapshot,         false, true,  .existingApp, false, false),
      (.screenshot,       false, true,  .noApp,       false, false),
      (.backInApp,        true,  false, .mayLaunch,   true,  true),
      (.backSystem,       true,  false, .mayLaunch,   true,  true),
      (.home,             false, false, .mayLaunch,   true,  true),
      (.rotate,           true,  false, .mayLaunch,   true,  true),
      (.appSwitcher,      true,  false, .mayLaunch,   true,  true),
      (.actionButton,     false, false, .hostedByFocusedSurface, true, true),
      (.keyboardDismiss,  true,  false, .mayLaunch,   true,  true),
      (.keyboardReturn,   true,  false, .mayLaunch,   true,  true),
      (.alert,            false, true,  .hostedByFocusedSurface, false, false),
      (.sequence,         true,  false, .mayLaunch,   true,  true),
      (.gesture,          true,  false, .mayLaunch,   true,  true),
      (.gestureViewport,  false, true,  .existingApp, false, false),
      (.recordStart,      false, false, .mayLaunch,   true,  true),
      (.recordStop,       false, false, .noApp,       false, true),
      (.status,           false, true,  .noApp,       false, false),
      (.uptime,           false, false, .noApp,       false, true),
      (.activate,         false, false, .mayLaunch,   true,  true),
      (.terminate,        false, false, .noApp,       false, true),
      (.targetReset,      false, false, .noApp,       false, true),
      (.shutdown,         false, false, .noApp,       false, true)
    ]
    for (type, interaction, retry, launch, converts, clears) in table {
      let request = #"{"command":"\#(type.rawValue)"}"#
      let command = try runnerCommandFixture(request)
      XCTAssertEqual(command.command, type, request)
      XCTAssertEqual(command.traits, traits(interaction, retry, launch, converts, clears), request)
    }
    XCTAssertEqual(
      Set(table.map { $0.0 }),
      Set(CommandType.allCases),
      "every command states its decisions in this table"
    )

    // The one payload-dependent command settles each fact per action: `get` changes nothing and may
    // be replayed, while `accept` and `dismiss` mutate and must not be.
    let alertCases: [(action: String?, expected: CommandTraits)] = [
      (nil, traits(false, true, .hostedByFocusedSurface, false, false)),
      ("get", traits(false, true, .hostedByFocusedSurface, false, false)),
      ("accept", traits(false, false, .hostedByFocusedSurface, true, true)),
      ("dismiss", traits(false, false, .hostedByFocusedSurface, true, true))
    ]
    for alertCase in alertCases {
      let request = alertCase.action.map { #"{"command":"alert","action":"\#($0)"}"# }
        ?? #"{"command":"alert"}"#
      XCTAssertEqual(try runnerCommandFixture(request).traits, alertCase.expected, request)
    }
  }
}
#endif
