import XCTest

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
private struct SnapshotBackendParityFixture: Decodable {
  struct Availability: Decodable {
    let simulator: Bool
    let physicalDevice: Bool
  }

  struct Backend: Decodable {
    let name: String
    let forceable: Bool
    let supportsRawProjection: Bool
    let regularDepth: String
    let hittable: String
    let availability: Availability
  }

  let backends: [Backend]
}

extension RunnerTests {
  private func loadSnapshotBackendParityFixture() throws -> SnapshotBackendParityFixture {
    let fixtureURL = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent() // UnitTests
      .deletingLastPathComponent() // AgentDeviceRunnerUITests
      .deletingLastPathComponent() // AgentDeviceRunner
      .deletingLastPathComponent() // runner
      .deletingLastPathComponent() // apple
      .deletingLastPathComponent() // repo root
      .appendingPathComponent("contracts")
      .appendingPathComponent("fixtures")
      .appendingPathComponent("ios-snapshot-backends.json")
    return try JSONDecoder().decode(
      SnapshotBackendParityFixture.self,
      from: Data(contentsOf: fixtureURL)
    )
  }

  /// The JSON table is the cross-runtime declaration used by the TypeScript capability registry
  /// and this runner. A backend case, forceability branch, projection/depth claim, or availability
  /// change that is not classified in both implementations fails before an iOS smoke can drift.
  func testSnapshotBackendDeclarationsMatchCapabilityFixture() throws {
    let fixture = try loadSnapshotBackendParityFixture()
    XCTAssertEqual(
      fixture.backends.map(\.name),
      SnapshotBackendKind.allCases.map(\.rawValue)
    )

    for expected in fixture.backends {
      guard let backend = SnapshotBackendKind(rawValue: expected.name) else {
        XCTFail("fixture contains an unknown snapshot backend: \(expected.name)")
        continue
      }
      XCTAssertEqual(backend.isForceable, expected.forceable, expected.name)
      XCTAssertEqual(backend.supportsRawProjection, expected.supportsRawProjection, expected.name)
      XCTAssertEqual(
        backend.regularDepthCapability.rawValue,
        expected.regularDepth,
        "regular depth capability: \(expected.name)"
      )
      XCTAssertEqual(
        backend.hittableSemantics,
        expected.hittable,
        "hittable semantics: \(expected.name)"
      )
      XCTAssertEqual(
        backend.isAvailable(on: .simulator),
        expected.availability.simulator,
        "simulator availability: \(expected.name)"
      )
      XCTAssertEqual(
        backend.isAvailable(on: .physicalDevice),
        expected.availability.physicalDevice,
        "physical-device availability: \(expected.name)"
      )
    }
  }
}
#endif
