import Foundation

// iOS out-of-process system surfaces the runner observes and drives IN PLACE, never by activation.
//
// `com.apple.SafariViewService` hosts `ASWebAuthenticationSession` / `SFSafariViewController` out
// of the app's process. Calling `XCUIApplication.activate()` (or `simctl launch`) on it cancels the
// authentication session and blacks the view (issue #2438), so the runner never activates such a
// host: it reads and drives it in place while it is genuinely presented over the session app.
//
// The canonical membership is the golden fixture shared with the TS twin. Drift on either side
// turns CI red without a simulator:
//   table:   contracts/fixtures/ios-system-surface-hosts.json
//   TS twin: packages/contracts/src/ios-system-surface.ts
//   TS test: packages/contracts/src/ios-system-surface.test.ts
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
