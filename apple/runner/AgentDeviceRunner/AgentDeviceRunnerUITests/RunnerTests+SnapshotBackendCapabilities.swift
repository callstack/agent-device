import XCTest

enum SnapshotBackendEnvironment {
  case simulator
  case physicalDevice
}

enum SnapshotBackendKind: String, CaseIterable {
  case recursiveTree = "tree"
  case querySweep = "queries"
  case privateAX = "private-ax"

  var isForceable: Bool {
    switch self {
    case .recursiveTree, .privateAX:
      return true
    case .querySweep:
      return false
    }
  }

  var hittableSemantics: String {
    "geometric-actionability"
  }

  var usesXCTestAccessibilityChannel: Bool {
    switch self {
    case .recursiveTree, .querySweep:
      return true
    case .privateAX:
      return false
    }
  }

  /// The raw projection is the acquired tree, so only a backend that enumerates a hierarchy can
  /// serve it. The query sweep answers an interactive element query: it has no hierarchy to
  /// return, and planning it for `--raw` is exactly how a raw request gets answered with regular
  /// membership.
  var supportsRawProjection: Bool {
    switch self {
    case .recursiveTree, .privateAX:
      return true
    case .querySweep:
      return false
    }
  }

  var isAvailableOnCurrentPlatform: Bool {
    #if os(iOS) && targetEnvironment(simulator)
      return isAvailable(on: .simulator)
    #else
      return isAvailable(on: .physicalDevice)
    #endif
  }

  func isAvailable(on environment: SnapshotBackendEnvironment) -> Bool {
    switch self {
    case .recursiveTree, .querySweep:
      return true
    case .privateAX:
      return environment == .simulator
    }
  }
}

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
    let hittable: String
    let availability: Availability
  }

  let backends: [Backend]
}

extension RunnerTests {
  private func loadSnapshotBackendParityFixture() throws -> SnapshotBackendParityFixture {
    let fixtureURL = URL(fileURLWithPath: #filePath)
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
  /// and this runner. A backend case, forceability branch, raw projection claim, or availability
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
