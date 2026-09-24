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
