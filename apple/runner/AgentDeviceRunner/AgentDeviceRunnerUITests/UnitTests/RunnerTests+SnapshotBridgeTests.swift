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
  func testMissingSimulatorIdentityRefusesSurfaceProofForThisCapture() throws {
    let payload = try JSONDecoder().decode(
      SnapshotBridgeCommandPayload.self,
      from: Data(
        #"{"verb":"describe","requestId":"r","generation":"g","expectedPid":9,"surfaceHostExecutables":["host"]}"#
          .utf8)
    )
    for udid: String? in [nil, ""] {
      let request = Self.snapshotBridgeReaderRequest(payload, simulatorUdid: udid)
      XCTAssertNil(request["simulatorUdid"])
      let response = RunnerSnapshotBridgeHandle("describe", "com.example.app", request)
      XCTAssertEqual(response["error_code"] as? String, "system-surface-host-unverified")
      XCTAssertEqual(response["pid"] as? Int, 9)
      XCTAssertEqual(response["generation"] as? String, "g")
    }
    let named = Self.snapshotBridgeReaderRequest(payload, simulatorUdid: "SIM")
    XCTAssertEqual(named["simulatorUdid"] as? String, "SIM")
  }
  func testAbandonedReadBecomesWedgedUntilItReturns() {
    let release = DispatchSemaphore(value: 0)
    let request = ["requestId": "wedge"]
    let first = RunnerSnapshotBridgeReadForTest(request, 100, {
      release.wait()
      return ["ok": true]
    }, 10)
    XCTAssertEqual(first["error_code"] as? String, "bridge-read-abandoned")
    let busy = RunnerSnapshotBridgeReadForTest(request, 100, { ["ok": true] }, 14.999)
    XCTAssertEqual(busy["error_code"] as? String, "bridge-read-in-flight")
    let wedged = RunnerSnapshotBridgeReadForTest(request, 100, { ["ok": true] }, 15)
    XCTAssertEqual(wedged["error_code"] as? String, "bridge-reader-wedged")
    release.signal()
    RunnerSnapshotBridgeDrainForTest()
    let admitted = RunnerSnapshotBridgeReadForTest(request, 1000, { ["ok": true] }, 16)
    XCTAssertEqual(admitted["ok"] as? Bool, true)

    // A read admitted after an abandoned one must not inherit the old abandon stamp (10): checked at
    // 100, while this read is still inside its budget, a stale stamp would answer bridge-reader-wedged.
    let started = DispatchSemaphore(value: 0)
    let secondRelease = DispatchSemaphore(value: 0)
    let secondAbandoned = expectation(description: "the second read is abandoned at its budget")
    DispatchQueue.global().async {
      let second = RunnerSnapshotBridgeReadForTest(request, 1000, {
        started.signal()
        secondRelease.wait()
        return ["ok": true]
      }, 100)
      XCTAssertEqual(second["error_code"] as? String, "bridge-read-abandoned")
      secondAbandoned.fulfill()
    }
    started.wait()
    let secondBusy = RunnerSnapshotBridgeReadForTest(request, 100, { ["ok": true] }, 100)
    XCTAssertEqual(secondBusy["error_code"] as? String, "bridge-read-in-flight")
    wait(for: [secondAbandoned], timeout: 5)
    secondRelease.signal()
    RunnerSnapshotBridgeDrainForTest()
  }

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

  #if !(os(iOS) && targetEnvironment(simulator))
  func testUnavailableBridgeRefusalCarriesProtocolVersions() throws {
    let envelope = RunnerSnapshotBridgeHandle("describe", "app", ["requestId": "r"])
    XCTAssertEqual(envelope["protocolVersion"] as? Int, 1)
    XCTAssertEqual(envelope["sourceVersion"] as? String, "agent-device-simulator-ax-v1.10.0")
    XCTAssertEqual(envelope["error_code"] as? String, "runner-bridge-unavailable")
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
    let command = try runnerCommandFixture(
      #"{"command":"snapshotBridge","appBundleId":"com.example.app","snapshotBridge":{"verb":"invalid","requestId":"request-1"}}"#
    )
    let envelope = try snapshotBridgeEnvelope(executeSnapshotBridge(command: command))
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
