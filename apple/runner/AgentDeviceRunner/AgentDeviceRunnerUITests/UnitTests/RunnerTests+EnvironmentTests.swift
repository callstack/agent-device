import XCTest
import Network

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
extension RunnerTests {
  private static let environmentToken = String(repeating: "t", count: 32)

  func testListenerConfigurationRequiresAPortAndAToken() {
    let port = ["AGENT_DEVICE_RUNNER_PORT": "8100"]
    let token = ["AGENT_DEVICE_RUNNER_TOKEN": Self.environmentToken]
    let configured = RunnerListenerConfiguration.fromEnvironment(port.merging(token) { $1 })
    XCTAssertEqual(configured?.port.rawValue, 8100)
    XCTAssertTrue(configured?.token.matches(Self.environmentToken) ?? false)

    XCTAssertNil(RunnerListenerConfiguration.fromEnvironment(port))
    XCTAssertNil(RunnerListenerConfiguration.fromEnvironment(token))
    for badPort in ["0", "", "65536", "-1", "80a"] {
      XCTAssertNil(
        RunnerListenerConfiguration.fromEnvironment(
          ["AGENT_DEVICE_RUNNER_PORT": badPort].merging(token) { $1 }
        ),
        badPort
      )
    }
    for badToken in ["", String(repeating: "t", count: 31)] {
      XCTAssertNil(
        RunnerListenerConfiguration.fromEnvironment(
          port.merging(["AGENT_DEVICE_RUNNER_TOKEN": badToken]) { $1 }
        ),
        "\(badToken.count)-byte token"
      )
    }
  }
  func testListenerConfigurationAcceptsOnlyConcreteBindAddresses() {
    let base = ["AGENT_DEVICE_RUNNER_PORT": "8100", "AGENT_DEVICE_RUNNER_TOKEN": String(repeating: "t", count: 32)]
    XCTAssertNil(RunnerListenerConfiguration.fromEnvironment(base)?.bindAddress)
    let remote = base.merging(["AGENT_DEVICE_RUNNER_BIND_IP": "10.244.2.3"]) { $1 }
    XCTAssertEqual(RunnerListenerConfiguration.fromEnvironment(remote)?.bindAddress?.debugDescription, "10.244.2.3")
    for invalid in ["", "0.0.0.0", "localhost", "10.244.2.999"] {
      XCTAssertNil(RunnerListenerConfiguration.fromEnvironment(base.merging(["AGENT_DEVICE_RUNNER_BIND_IP": invalid]) { $1 }))
    }
  }

}
#endif
