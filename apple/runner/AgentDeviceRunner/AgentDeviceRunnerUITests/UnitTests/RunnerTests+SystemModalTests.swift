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
    let resolved = ResolvedBlockingSystemModal(
      root: app,
      ownerApp: app,
      actions: actionableElements(in: app),
      window: nil
    )
    let payload = try XCTUnwrap(try snapshotForBlockingSystemModal(resolved))
    let off = try XCTUnwrap(payload.nodes?.first { $0.identifier == "native-off" })
    let on = try XCTUnwrap(payload.nodes?.first { $0.identifier == "native-on" })
    XCTAssertEqual(off.value, "0")
    XCTAssertEqual(on.value, "1")
  }

  func testSpringBoardModalIsPlacedInItsOwnPanelWindow() {
    let outerPanel = CGRect(x: 0, y: 0, width: 466, height: 678)
    let innerPanel = CGRect(x: 0, y: 0, width: 951, height: 669)
    let innerPanelAlert = CGRect(x: 341, y: 250, width: 270, height: 170)
    XCTAssertTrue(Self.isPlaced(innerPanelAlert, in: innerPanel))
    XCTAssertFalse(Self.isPlaced(innerPanelAlert, in: outerPanel))
    XCTAssertFalse(Self.isPlaced(innerPanelAlert, in: CGRect(x: 0, y: 0, width: CGFloat.infinity, height: 669)))
    XCTAssertFalse(Self.isPlaced(.zero, in: innerPanel))
  }
#endif
}
