import Foundation

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
      .deletingLastPathComponent() // UnitTests
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
}
#endif
