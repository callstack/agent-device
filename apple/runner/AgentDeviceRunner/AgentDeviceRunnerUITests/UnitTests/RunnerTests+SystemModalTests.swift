import XCTest
import AgentDeviceSnapshotPresentation

extension RunnerTests {
#if AGENT_DEVICE_RUNNER_UNIT_TESTS && os(iOS)
  @MainActor
  func testBlockingModalSnapshotPreservesNativeSwitchValues() throws {
    app.launchArguments = ["--agent-device-native-states"]
    app.launch()
    defer { app.terminate() }
    XCTAssertTrue(app.switches["native-off"].waitForFixtureExistence(timeout: appExistenceTimeout))
    let resolved = ResolvedBlockingSystemModal(root: app, ownerApp: app, actions: actionableElements(in: app))
    let payload = try XCTUnwrap(snapshotForBlockingSystemModal(resolved))
    let off = try XCTUnwrap(payload.nodes?.first { $0.identifier == "native-off" })
    let on = try XCTUnwrap(payload.nodes?.first { $0.identifier == "native-on" })
    XCTAssertEqual(off.value, "0")
    XCTAssertEqual(on.value, "1")
  }
#endif
}
