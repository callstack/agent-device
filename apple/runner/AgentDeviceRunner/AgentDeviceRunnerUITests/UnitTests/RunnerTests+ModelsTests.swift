import Foundation
import XCTest

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
extension RunnerTests {
  func testErrorPayloadEncodesEveryFieldButTheRunnerInternalRetryableFailure() throws {
    let payload = ErrorPayload(
      code: "CODE",
      message: "message",
      hint: "hint",
      retryableFailure: .targetAppUnavailable
    )
    let encoded = try JSONEncoder().encode(payload)
    let object = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
    let storedFields = Set(Mirror(reflecting: payload).children.compactMap(\.label))
    XCTAssertEqual(Set(object.keys), storedFields.subtracting(["retryableFailure"]))
  }

  func testTargetAppUnavailableErrorKeepsItsWireShape() throws {
    let encoded = try JSONEncoder().encode(
      ErrorPayload.targetAppUnavailable(bundleId: "com.example.app")
    )
    let object = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
    XCTAssertEqual(Array(object.keys), ["message"])
    XCTAssertEqual(object["message"] as? String, "app 'com.example.app' is not available")
    XCTAssertEqual(
      ErrorPayload.targetAppUnavailable(bundleId: nil).message,
      "runner app is not available"
    )
  }

  func runnerCommandFixture(_ json: String) throws -> Command {
    try JSONDecoder().decode(Command.self, from: Data(json.utf8))
  }
}
#endif
