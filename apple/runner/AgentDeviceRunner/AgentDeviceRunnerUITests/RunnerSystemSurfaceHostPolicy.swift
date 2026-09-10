import Foundation

// iOS out-of-process system surfaces observed and driven IN PLACE, never activated: activating such
// a host cancels what it presents (issue #2438; rationale in docs/adr/0004). Membership is the
// golden fixture contracts/fixtures/ios-system-surface-hosts.json, mirrored by the TS twin
// packages/contracts/src/ios-system-surface.ts; drift fails on either side without a simulator.
enum SystemSurfaceHostKind: String {
  case webAuth = "web-auth"
}

struct SystemSurfaceHost: Equatable {
  let bundleId: String
  let kind: SystemSurfaceHostKind
}

enum SystemSurfaceHostRegistry {
  static let hosts: [SystemSurfaceHost] = [
    SystemSurfaceHost(bundleId: "com.apple.SafariViewService", kind: .webAuth)
  ]

  static func host(forBundleId bundleId: String?) -> SystemSurfaceHost? {
    guard let bundleId else { return nil }
    return hosts.first { $0.bundleId == bundleId }
  }

  static func isSystemSurfaceHost(_ bundleId: String?) -> Bool {
    host(forBundleId: bundleId) != nil
  }
}

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
import XCTest

private struct SystemSurfaceHostFixture: Decodable {
  struct Host: Decodable {
    let bundleId: String
    let kind: String
  }
  let hosts: [Host]
}

extension RunnerTests {
  func testSystemSurfaceHostRegistryMirrorsGoldenFixture() throws {
    let fixtureURL = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent() // AgentDeviceRunnerUITests
      .deletingLastPathComponent() // AgentDeviceRunner
      .deletingLastPathComponent() // runner
      .deletingLastPathComponent() // apple
      .deletingLastPathComponent() // repo root
      .appendingPathComponent("contracts")
      .appendingPathComponent("fixtures")
      .appendingPathComponent("ios-system-surface-hosts.json")
    let fixture = try JSONDecoder().decode(
      SystemSurfaceHostFixture.self,
      from: Data(contentsOf: fixtureURL)
    )
    let registry = SystemSurfaceHostRegistry.hosts.map { [$0.bundleId, $0.kind.rawValue] }
    let golden = fixture.hosts.map { [$0.bundleId, $0.kind] }
    XCTAssertEqual(registry, golden, "SystemSurfaceHostRegistry drifted from the golden fixture")
  }

  func testSystemSurfaceHostRegistryRecognizesRegisteredHosts() {
    XCTAssertTrue(SystemSurfaceHostRegistry.isSystemSurfaceHost("com.apple.SafariViewService"))
    XCTAssertFalse(SystemSurfaceHostRegistry.isSystemSurfaceHost("com.example.app"))
    XCTAssertFalse(SystemSurfaceHostRegistry.isSystemSurfaceHost(nil))
    XCTAssertEqual(
      SystemSurfaceHostRegistry.host(forBundleId: "com.apple.SafariViewService")?.kind,
      .webAuth
    )
  }
}
#endif
