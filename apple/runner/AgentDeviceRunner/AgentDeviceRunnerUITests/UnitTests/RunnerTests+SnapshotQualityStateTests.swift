import XCTest
import AgentDeviceSnapshotPresentation

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
extension RunnerTests {
  private struct StampedWireVerdict: Decodable {
    struct Quality: Decodable {
      let state: String
    }
    let snapshotQuality: Quality
  }

  private func loadSnapshotQualityStatesFixture() throws -> [String] {
    let fixtureURL = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent() // UnitTests
      .deletingLastPathComponent() // AgentDeviceRunnerUITests
      .deletingLastPathComponent() // AgentDeviceRunner
      .deletingLastPathComponent() // runner
      .deletingLastPathComponent() // apple
      .deletingLastPathComponent() // repo root
      .appendingPathComponent("contracts")
      .appendingPathComponent("fixtures")
      .appendingPathComponent("ios-snapshot-quality-states.json")
    return try JSONDecoder().decode([String].self, from: Data(contentsOf: fixtureURL))
  }

  private func wireTestCapture() -> SnapshotBackendCapture {
    SnapshotBackendCapture(
      payload: DataPayload(
        nodes: [
          SnapshotPresentation.singleElementRead(
            RawAXNode(
              index: 0,
              type: "Application",
              label: "App",
              identifier: nil,
              value: nil,
              rect: SnapshotRect(.zero),
              enabled: true,
              focused: nil,
              selected: nil,
              hittable: true,
              depth: 0,
              parentIndex: nil,
              hiddenContentAbove: nil,
              hiddenContentBelow: nil
            )
          )
        ],
        truncated: false
      ),
      effectiveDepth: nil
    )
  }

  /// The one claim of this file: the runner's closed enum and the shared TypeScript table name the
  /// same states in the same order. The kernel's `SNAPSHOT_QUALITY_STATES` is pinned to it too, so
  /// the two runtimes cannot drift into a verdict the host drops along with its disclosure.
  func testSnapshotQualityStatesMatchSharedWireFixture() throws {
    XCTAssertEqual(
      try loadSnapshotQualityStatesFixture(),
      SnapshotQualityState.allCases.map(\.rawValue),
      "update the fixture and the kernel tuple together with the enum"
    )
  }

  /// What the daemon receives for each state, taken from the production stamping path rather than a
  /// hand-built verdict: the wire string is the fixture's, so a change of representation — an
  /// `Int` backing, a nested object, a renamed case — goes red here on the actual payload.
  func testStampedVerdictEncodesTheFixtureStateString() throws {
    let fixture = try loadSnapshotQualityStatesFixture()
    XCTAssertEqual(fixture.count, SnapshotQualityState.allCases.count)
    for (index, state) in SnapshotQualityState.allCases.enumerated() {
      let payload = stampedSnapshotPayload(
        wireTestCapture(),
        backend: .recursiveTree,
        state: state,
        reason: nil
      )
      let wire = try JSONDecoder().decode(
        StampedWireVerdict.self,
        from: JSONEncoder().encode(payload)
      )
      XCTAssertEqual(wire.snapshotQuality.state, fixture[index], state.rawValue)
    }
  }

  /// Closed in both directions: a wire string nobody declared never becomes a verdict.
  func testVerdictStateRejectsAnUndeclaredWireString() throws {
    let json = Data(#"{"state":"degraded","backend":"tree"}"#.utf8)
    XCTAssertThrowsError(try JSONDecoder().decode(SnapshotQuality.self, from: json))
  }
}
#endif
