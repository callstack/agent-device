import Foundation
import XCTest

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
extension RunnerTests {
  private func snapshotBridgeEnvelope(_ response: Response) throws -> [String: Any] {
    let text = try XCTUnwrap(response.data?.snapshotBridgeEnvelope, "no bridge envelope")
    return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
  }

  func testSnapshotBridgeAppReadRequiresTheAppBundleId() throws {
    let command = try runnerCommandFixture(
      #"{"command":"snapshotBridge","snapshotBridge":{"verb":"describe","requestId":"r"}}"#
    )
    let response = executeSnapshotBridge(command: command)
    XCTAssertFalse(response.ok)
    XCTAssertEqual(response.error?.code, "INVALID_ARGS")
  }

  func testUnserializableSnapshotBridgeEnvelopeIsRefusedAsNotJsonSafe() throws {
    let text = Self.serializedSnapshotBridgeEnvelope(
      ["requestId": "r", "ok": true, "pid": 7, "tree": Date()],
      requestId: "r",
      maxBytes: 1024
    )
    let refusal = try XCTUnwrap(
      JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any]
    )
    XCTAssertEqual(refusal["error_kind"] as? String, "malformed_tree")
    XCTAssertEqual(refusal["error_code"] as? String, "response-not-json-safe")
    XCTAssertEqual(refusal["pid"] as? Int, 7)
  }

  func testOversizedSnapshotBridgeEnvelopeBecomesTheGuestRefusalWithItsIdentity() throws {
    let text = Self.serializedSnapshotBridgeEnvelope(
      [
        "requestId": "r", "ok": true, "pid": 7, "generation": "g", "processStartTime": "1.000001",
        "tree": String(repeating: "x", count: 2048),
      ],
      requestId: "r",
      maxBytes: 1024
    )
    let refusal = try XCTUnwrap(
      JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any]
    )
    XCTAssertEqual(refusal["ok"] as? Bool, false)
    XCTAssertEqual(refusal["error_kind"] as? String, "response_limit_exceeded")
    XCTAssertEqual(refusal["error_code"] as? String, "response-too-large")
    XCTAssertEqual(refusal["requestId"] as? String, "r")
    XCTAssertEqual(refusal["pid"] as? Int, 7)
    XCTAssertEqual(refusal["generation"] as? String, "g")
    XCTAssertNil(refusal["tree"])
  }
}
#endif
