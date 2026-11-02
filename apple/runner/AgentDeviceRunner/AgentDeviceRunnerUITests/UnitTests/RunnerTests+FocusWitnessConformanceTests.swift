import XCTest

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
extension RunnerTests {
  private struct FocusWitnessFixture: Decodable {
    struct Case: Decodable {
      let name: String
      let hasFocus: Bool?
      let hasKeyboardFocus: Bool?
      let focused: Bool

      /// KVC-readable the way a snapshot answers focus: a key the case omits reads as nil.
      var snapshot: NSDictionary {
        var values: [String: Any] = [:]
        if let hasFocus { values["hasFocus"] = hasFocus }
        if let hasKeyboardFocus { values["hasKeyboardFocus"] = hasKeyboardFocus }
        return values as NSDictionary
      }
    }
    let cases: [Case]
  }

  private func loadFocusWitnessFixture() throws -> FocusWitnessFixture {
    let fixtureURL = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent() // UnitTests
      .deletingLastPathComponent() // AgentDeviceRunnerUITests
      .deletingLastPathComponent() // AgentDeviceRunner
      .deletingLastPathComponent() // runner
      .deletingLastPathComponent() // apple
      .deletingLastPathComponent() // repo root
      .appendingPathComponent("contracts")
      .appendingPathComponent("fixtures")
      .appendingPathComponent("ios-focus-witness.json")
    return try JSONDecoder().decode(FocusWitnessFixture.self, from: Data(contentsOf: fixtureURL))
  }

  /// The XCTest producers (recursive tree, query sweep, collapsed tabs) and the private-AX bridge
  /// each derive `focused` from the same two keys. A producer that reads fewer keys reports a
  /// keyboard-focused text input as unfocused.
  func testSnapshotProducersReportTheSameFocusedForEachFocusWitness() throws {
    let fixture = try loadFocusWitnessFixture()
    XCTAssertFalse(fixture.cases.isEmpty)
    for focusCase in fixture.cases {
      XCTAssertEqual(
        focusBool(focusCase.snapshot), focusCase.focused, "\(focusCase.name): XCTest producers")

      let response = RunnerAXSnapshotBridge.snapshotTree(
        withClient: FocusWitnessAXClient(snapshot: focusCase.snapshot),
        target: NSObject(),
        maxDepth: 1,
        maxNodes: 1,
        deepExtensionCallLimit: 0,
        customActionLimit: 0,
        deadline: nil)
      let root = response["root"] as? [String: Any]
      XCTAssertEqual(root?["focused"] as? Bool, focusCase.focused, "\(focusCase.name): private-AX bridge")
    }
  }
}

/// Stands in for the private AX client: answers every snapshot request with one root snapshot.
private final class FocusWitnessAXClient: NSObject {
  private let snapshot: NSDictionary

  init(snapshot: NSDictionary) { self.snapshot = snapshot }

  @objc(requestSnapshotForElement:attributes:parameters:error:)
  func requestSnapshot(
    forElement element: Any, attributes: Any, parameters: [String: Any], error: NSErrorPointer
  ) -> Any? {
    snapshot
  }
}
#endif
