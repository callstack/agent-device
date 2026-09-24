import XCTest

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

  /// The one claim of this file: the runner's closed enum and the shared TypeScript table name the
  /// same states. The kernel's `SNAPSHOT_QUALITY_STATES` is pinned to it too, so the two runtimes
  /// cannot drift into a verdict the host drops along with its disclosure. Compared as a set: the
  /// names are the contract, and a reordering of `allCases` cannot produce a wrong verdict.
  func testSnapshotQualityStatesMatchSharedWireFixture() throws {
    XCTAssertEqual(
      Set(try loadSnapshotQualityStatesFixture()),
      Set(SnapshotQualityState.allCases.map(\.rawValue)),
      "update the fixture and the kernel tuple together with the enum"
    )
  }

  /// What the daemon receives for each state, taken from the production stamping path rather than a
  /// hand-built verdict: the wire string is the case's own raw value, so a change of
  /// representation — an `Int` backing, a nested object — goes red here on the actual payload, and
  /// a renamed raw value goes red in the fixture test above.
  func testStampedVerdictEncodesTheCaseRawValue() throws {
    let capture = SnapshotBackendCapture(
      payload: DataPayload(nodes: [], truncated: false),
      effectiveDepth: nil
    )
    for state in SnapshotQualityState.allCases {
      let payload = stampedSnapshotPayload(
        capture,
        backend: .recursiveTree,
        state: state,
        reason: nil
      )
      let wire = try JSONDecoder().decode(
        StampedWireVerdict.self,
        from: JSONEncoder().encode(payload)
      )
      XCTAssertEqual(wire.snapshotQuality.state, state.rawValue)
    }
  }

  /// Closed in both directions: a wire string nobody declared never becomes a verdict.
  func testVerdictStateRejectsAnUndeclaredWireString() throws {
    let json = Data(#"{"state":"degraded","backend":"tree"}"#.utf8)
    XCTAssertThrowsError(try JSONDecoder().decode(SnapshotQuality.self, from: json))
  }
}
#endif
