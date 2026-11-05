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

  private func firstReadPayload() throws -> SnapshotBridgeCommandPayload {
    try JSONDecoder().decode(
      SnapshotBridgeCommandPayload.self,
      from: Data(
        #"{"verb":"describe","requestId":"r","generation":"1:2.000001","expectedPid":9,"expectedProcessStartTime":"2.000001","maxDepth":8,"maxNodes":500,"maxDurationMs":2500,"maxResponseBytes":4096}"#
          .utf8)
    )
  }

  func testFirstReadOfAGenerationSendsNoKeyForAnAbsentHint() throws {
    let request = Self.snapshotBridgeReaderRequest(try firstReadPayload()) as NSDictionary
    XCTAssertNil(request["nativeLevelsHint"])
    XCTAssertFalse(request.allKeys.contains { ($0 as? String) == "nativeLevelsHint" })
    XCTAssertFalse(request.allValues.contains { $0 is NSNull })
    XCTAssertEqual(request["generation"] as? String, "1:2.000001")
    XCTAssertEqual(request["maxResponseBytes"] as? Int, 4096)
  }

  func testBridgedRequestKeepsAHintTheHostSent() throws {
    let payload = try JSONDecoder().decode(
      SnapshotBridgeCommandPayload.self,
      from: Data(
        #"{"verb":"describe","requestId":"r","generation":"g","nativeLevelsHint":3}"#.utf8)
    )
    let request = Self.snapshotBridgeReaderRequest(payload) as NSDictionary
    XCTAssertEqual(request["nativeLevelsHint"] as? Int, 3)
    XCTAssertNil(request["maxDepth"])
  }

  // The runner compiles the shared reader only for the iOS Simulator (RunnerSnapshotBridge.m).
  #if os(iOS) && targetEnvironment(simulator)
  func testReaderDoesNotRefuseTheBoundsOfAFirstRead() throws {
    var request = Self.snapshotBridgeReaderRequest(try firstReadPayload())
    request["pid"] = 1
    request["maxDurationMs"] = 500
    let refusal = SnapshotBridgeHandleRequest(request)
    XCTAssertNotEqual(refusal["error_code"] as? String, "bounds-invalid")
    XCTAssertNotEqual(refusal["error_kind"] as? String, "bad_request")
  }

  func testReaderRefusesAJsonBooleanWhereANumberIsRequired() throws {
    var request = Self.snapshotBridgeReaderRequest(try firstReadPayload())
    request["pid"] = true
    XCTAssertEqual(SnapshotBridgeHandleRequest(request)["error_code"] as? String, "pid-required")
    request["pid"] = 1
    request["maxDepth"] = false
    XCTAssertEqual(SnapshotBridgeHandleRequest(request)["error_code"] as? String, "bounds-invalid")
  }
  #endif

  func testEnvelopeAtTheBoundIncludingItsFrameHeaderIsServed() throws {
    let envelope: [AnyHashable: Any] = ["requestId": "r", "ok": true, "pid": 7]
    let size = try JSONSerialization.data(withJSONObject: envelope).count
    let header = Self.snapshotBridgeFrameHeaderBytes
    let served = Self.serializedSnapshotBridgeEnvelope(
      envelope, requestId: "r", maxBytes: size + header)
    XCTAssertEqual(
      try JSONSerialization.jsonObject(with: Data(served.utf8)) as? NSDictionary,
      envelope as NSDictionary)
    let refused = Self.serializedSnapshotBridgeEnvelope(
      envelope, requestId: "r", maxBytes: size + header - 1)
    let refusal = try XCTUnwrap(
      JSONSerialization.jsonObject(with: Data(refused.utf8)) as? [String: Any])
    XCTAssertEqual(refusal["error_code"] as? String, "response-too-large")
  }

  func testTheRunnersOwnRefusalFitsTheDefaultBound() throws {
    let refusal = RunnerSnapshotBridgeHandle("describe", "", ["requestId": "request-1"])
    let text = Self.serializedSnapshotBridgeEnvelope(
      refusal,
      requestId: "request-1",
      maxBytes: Self.snapshotBridgeMaximumResponseBytes
    )
    let envelope = try XCTUnwrap(
      JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any]
    )
    XCTAssertNotEqual(envelope["error_code"] as? String, "response-too-large")
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
