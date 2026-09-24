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

  func testProductionRunnerRequestsDecodeWithoutDroppingAKey() throws {
    for (name, request) in try productionRunnerRequests() {
      let command = try decodeProductionRunnerRequest(request, name)
      XCTAssertEqual(command.command.rawValue, request["command"] as? String, name)
      let reencoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(command))
      XCTAssertEqual(runnerRequestKeyPaths(reencoded), runnerRequestKeyPaths(request), name)
    }
  }

  func testEveryRunnerCommandTypeHasAProductionRequest() throws {
    let produced = Set(try productionRunnerRequests().compactMap { $0.request["command"] as? String })
    let orphaned = CommandType.allCases.map(\.rawValue).filter { !produced.contains($0) }
    XCTAssertEqual(orphaned, [], "CommandType cases with no production request")
  }

  func testEveryRunnerRequestFieldHasAProductionRequest() throws {
    let entries = try productionRunnerRequests()
    let requests = entries.map(\.request)
    let steps = requests.flatMap { $0["steps"] as? [[String: Any]] ?? [] }
    let plans = requests.compactMap { $0["gesturePlan"] as? [String: Any] }
    let pointers = plans.flatMap { $0["pointers"] as? [[String: Any]] ?? [] }
    let samples = pointers.flatMap { $0["samples"] as? [[String: Any]] ?? [] }
    let commands = try entries.map { try decodeProductionRunnerRequest($0.request, $0.name) }
    let command = try XCTUnwrap(commands.first, "no production request")
    let plan = try XCTUnwrap(
      commands.compactMap(\.gesturePlan).first,
      "no production request carries a gesturePlan"
    )
    let step = try JSONDecoder().decode(SequenceStep.self, from: Data(#"{"kind":"tap"}"#.utf8))
    let sample = try XCTUnwrap(plan.pointers.first?.samples.first)
    assertEveryStoredField(of: command, appearsIn: requests, "Command")
    assertEveryStoredField(of: step, appearsIn: steps, "SequenceStep")
    assertEveryStoredField(of: plan, appearsIn: plans, "RunnerGesturePlan")
    assertEveryStoredField(
      of: plan.viewport,
      appearsIn: plans.compactMap { $0["viewport"] as? [String: Any] },
      "RunnerGestureViewport"
    )
    assertEveryStoredField(of: plan.pointers[0], appearsIn: pointers, "RunnerGesturePointer")
    assertEveryStoredField(of: sample, appearsIn: samples, "RunnerGestureSample")
    assertEveryStoredField(
      of: sample.point,
      appearsIn: samples.compactMap { $0["point"] as? [String: Any] },
      "RunnerGesturePoint"
    )
  }

  private func productionRunnerRequests() throws -> [(name: String, request: [String: Any])] {
    let fixtureURL = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .appendingPathComponent("contracts/fixtures/runner-requests.json")
    let entries = try XCTUnwrap(
      JSONSerialization.jsonObject(with: Data(contentsOf: fixtureURL)) as? [[String: Any]]
    )
    return try entries.map { entry in
      (
        name: try XCTUnwrap(entry["name"] as? String),
        request: try XCTUnwrap(entry["request"] as? [String: Any], "\(entry["name"] ?? "?")")
      )
    }
  }

  private func decodeProductionRunnerRequest(_ request: [String: Any], _ name: String) throws
    -> Command
  {
    do {
      return try JSONDecoder().decode(
        Command.self,
        from: JSONSerialization.data(withJSONObject: request)
      )
    } catch {
      XCTFail("\(name) does not decode as Command: \(error)")
      throw error
    }
  }

  private func runnerRequestKeyPaths(_ value: Any, _ prefix: String = "") -> Set<String> {
    if let object = value as? [String: Any] {
      return object.reduce(into: Set<String>()) { paths, field in
        paths.insert(prefix + field.key)
        paths.formUnion(runnerRequestKeyPaths(field.value, "\(prefix)\(field.key)."))
      }
    }
    if let array = value as? [Any] {
      return array.reduce(into: Set<String>()) { paths, element in
        paths.formUnion(runnerRequestKeyPaths(element, "\(prefix)[]."))
      }
    }
    return []
  }

  private func assertEveryStoredField(
    of value: Any,
    appearsIn objects: [[String: Any]],
    _ level: String
  ) {
    let fields = Set(Mirror(reflecting: value).children.compactMap(\.label))
    let produced = Set(objects.flatMap(\.keys))
    XCTAssertEqual(
      fields.subtracting(produced).sorted(),
      [],
      "\(level) fields with no production request"
    )
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
