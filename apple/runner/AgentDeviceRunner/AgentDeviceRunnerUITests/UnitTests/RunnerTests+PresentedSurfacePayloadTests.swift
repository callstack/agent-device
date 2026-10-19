import XCTest
import AgentDeviceSnapshotPresentation

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
// #3565: a capture has to say whether it read a modal presentation over the app. The blocking
// system-modal probe is the one capture that can state `presented` without reading any window
// structure: the tree it publishes holds only the modal, so nothing downstream could read a
// presentation out of it. Only the payload factory is pinned here, because the probe body that calls it
// enumerates XCUIElements and needs a device.
extension RunnerTests {
  func testResolvedBlockingSystemModalPayloadStatesAPresentedSurface() {
    XCTAssertEqual(Self.blockingSystemModalPayload(nodes: []).presentedSurface, .presented)
  }

  // Silence is the answer a consumer must not be able to confuse with absence: a capture the runner
  // never classified (an older runner, a tier that published no reading) encodes no key at all.
  func testUnclassifiedSnapshotPayloadEncodesNoPresentedSurfaceKey() throws {
    let encoded = try JSONEncoder().encode(DataPayload(nodes: [], truncated: false))
    let object = try XCTUnwrap(
      JSONSerialization.jsonObject(with: encoded) as? [String: Any],
      "the snapshot payload encodes as an object"
    )
    XCTAssertNil(object["presentedSurface"])
  }
}
#endif
