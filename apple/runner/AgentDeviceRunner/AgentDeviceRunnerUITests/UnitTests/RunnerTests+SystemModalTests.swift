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
    let actions = try readModalActions(in: app, deadline: .distantFuture)
    let resolved = RunnerAlert(
      root: app,
      ownerApp: app,
      actions: actions,
      source: .blockingSystemModal,
      window: nil
    )
    let payload = try XCTUnwrap(try snapshotForBlockingSystemModal(resolved))
    let off = try XCTUnwrap(payload.nodes?.first { $0.identifier == "native-off" })
    let on = try XCTUnwrap(payload.nodes?.first { $0.identifier == "native-on" })
    XCTAssertEqual(off.value, "0")
    XCTAssertEqual(on.value, "1")
  }

  @MainActor
  func testBlockingModalSnapshotIncludesDisabledActions() throws {
    app.launchArguments = ["--agent-device-alert-replacement-regression", "--agent-device-alert-replacement-disabled-buttons"]
    app.launch()
    defer { app.terminate() }
    let alert = try requireResolvedAlert(within: Self.defaultAlertCommandTimeout)
    XCTAssertEqual(alert.actions.count, 2)
    for raw in [false, true] {
      let options = PresentationOptions(interactiveOnly: false, depth: nil, scope: nil, raw: raw)
      let payload = try XCTUnwrap(try snapshotForBlockingSystemModal(alert, options: options))
      let buttons = try XCTUnwrap(payload.nodes).filter { $0.type == "Button" }
      XCTAssertEqual(buttons.compactMap(\.label).sorted(), ["Cancel", "OK"], "raw=\(raw)")
      XCTAssertTrue(buttons.allSatisfy { $0.enabled == false }, "raw=\(raw)")
    }
  }
#endif
}
