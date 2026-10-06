import XCTest
import AgentDeviceSnapshotPresentation

extension RunnerTests {
#if AGENT_DEVICE_RUNNER_UNIT_TESTS
  private static let otpFieldIdentity = TextEntryElementIdentity(
    identifier: "otp-input",
    elementType: "TextField",
    frame: CGRect(x: 40, y: 200, width: 290, height: 52)
  )

  private static func otpObservation(
    _ value: String,
    identity: TextEntryElementIdentity = otpFieldIdentity
  ) -> TextEntryObservation {
    TextEntryObservation(value: value, identity: identity)
  }

  func testDegradedEchoesStayEchoesAndSummariesDoNot() {
    XCTAssertTrue(Self.textEntryValueEchoes(observed: "", expected: "123456", baseline: ""))
    XCTAssertTrue(Self.textEntryValueEchoes(observed: "12456", expected: "123456", baseline: ""))
    XCTAssertTrue(Self.textEntryValueEchoes(observed: "old123456", expected: "123456", baseline: ""))
    XCTAssertTrue(Self.textEntryValueEchoes(observed: "(555) 123-4567", expected: "5551234567", baseline: ""))
    XCTAssertTrue(Self.textEntryValueEchoes(observed: "hello", expected: "hello\n", baseline: ""))
    XCTAssertFalse(Self.textEntryValueEchoes(observed: "6 of 6 digits", expected: "123456", baseline: ""))
    XCTAssertFalse(Self.textEntryValueEchoes(observed: "6 digits", expected: "123456", baseline: ""))
  }

  func testDigitCountSummaryThatMovedOffItsBaselineIsUnconfirmed() {
    let evidence = Self.unconfirmedTextEntryEvidence(
      requested: "123456",
      baseline: Self.otpObservation("0 of 6 digits"),
      observed: Self.otpObservation("6 of 6 digits")
    )

    XCTAssertEqual(
      evidence,
      TextEntryUnconfirmedEvidence(
        requested: "123456",
        before: "0 of 6 digits",
        after: "6 of 6 digits",
        target: Self.otpFieldIdentity
      )
    )
  }

  func testSingleCharacterTheSummaryAlreadyContainedIsUnconfirmed() {
    let evidence = Self.unconfirmedTextEntryEvidence(
      requested: "6",
      baseline: Self.otpObservation("0 of 6 digits"),
      observed: Self.otpObservation("1 of 6 digits")
    )

    XCTAssertEqual(evidence?.after, "1 of 6 digits")
  }

  func testRequestTheBaselineContainedEchoesOnlyWithTheBaseline() {
    XCTAssertTrue(Self.textEntryValueEchoes(observed: "66", expected: "6", baseline: "6"))
    XCTAssertTrue(Self.textEntryValueEchoes(observed: "0 of 6 digits6", expected: "6", baseline: "0 of 6 digits"))
    XCTAssertFalse(Self.textEntryValueEchoes(observed: "1 of 6 digits", expected: "6", baseline: "0 of 6 digits"))
    XCTAssertFalse(Self.textEntryValueEchoes(observed: "6 of 6 digits", expected: "123456", baseline: "0 of 6 digits"))
    XCTAssertTrue(Self.textEntryValueEchoes(observed: "abc123abc12", expected: "abc123", baseline: "abc123"))
  }

  func testEveryOtherReplacementMismatchStaysAFailure() {
    let baseline = Self.otpObservation("0 of 6 digits")
    let otherField = TextEntryElementIdentity(
      identifier: "name-input",
      elementType: "TextField",
      frame: Self.otpFieldIdentity.frame
    )
    let cases: [(String, String, TextEntryObservation?, TextEntryObservation?)] = [
      ("value never moved", "123456", baseline, Self.otpObservation("0 of 6 digits")),
      ("dropped characters echo the request", "123456", baseline, Self.otpObservation("12456")),
      (
        "dropped characters echo a stale baseline plus the request", "abc123",
        Self.otpObservation("abc123"), Self.otpObservation("abc123abc12")
      ),
      ("another element took the entry", "123456", baseline, Self.otpObservation("6 of 6 digits", identity: otherField)),
      ("unreadable before the entry", "123456", nil, Self.otpObservation("6 of 6 digits")),
      ("unreadable after the entry", "123456", baseline, nil),
      ("nothing formats the empty value", "", baseline, Self.otpObservation("6 of 6 digits")),
      ("a bare submit key types no text", "\n", baseline, Self.otpObservation("6 of 6 digits")),
    ]
    for (name, requested, before, after) in cases {
      XCTAssertNil(
        Self.unconfirmedTextEntryEvidence(requested: requested, baseline: before, observed: after),
        name
      )
    }
  }

  func testElementWithoutIdentifierIsTheSameOnlyAtTheSameTypeAndFrame() {
    let frame = CGRect(x: 0, y: 0, width: 100, height: 40)
    let field = TextEntryElementIdentity(identifier: nil, elementType: "TextField", frame: frame)

    XCTAssertTrue(field.isSameElement(as: TextEntryElementIdentity(identifier: nil, elementType: "TextField", frame: frame)))
    XCTAssertFalse(field.isSameElement(as: TextEntryElementIdentity(identifier: nil, elementType: "TextView", frame: frame)))
    XCTAssertFalse(field.isSameElement(as: TextEntryElementIdentity(identifier: nil, elementType: "TextField", frame: frame.offsetBy(dx: 0, dy: 60))))
    XCTAssertFalse(field.isSameElement(as: TextEntryElementIdentity(identifier: "otp-input", elementType: "TextField", frame: frame)))
  }

  func testVerificationTargetEncodesMissingIdentityAsExplicitNulls() throws {
    let payload = TextEntryVerificationTargetPayload(
      resourceId: nil,
      className: "TextField",
      packageName: nil,
      rect: SnapshotRect(x: 1, y: 2, width: 3, height: 4)
    )
    let json = try XCTUnwrap(
      JSONSerialization.jsonObject(with: JSONEncoder().encode(payload)) as? [String: Any]
    )

    XCTAssertTrue(json["resourceId"] is NSNull)
    XCTAssertTrue(json["packageName"] is NSNull)
    XCTAssertEqual(json["className"] as? String, "TextField")
    XCTAssertEqual(json["rect"] as? [String: Double], ["x": 1, "y": 2, "width": 3, "height": 4])
  }

#if os(iOS)
  /// An OTP field that announces "6 of 6 digits" instead of the digits it holds. Every digit
  /// arrives, so the fill succeeds with evidence instead of failing on a summary it compared
  /// against the code, and the code is typed once rather than retyped by a repair.
  @MainActor
  func testFillIntoDigitCountFieldReportsUnconfirmedEvidence() throws {
    try assertDigitCountFillIsUnconfirmed(code: "123456", summary: "6 of 6 digits")
  }

  /// A single digit the "0 of 6 digits" baseline already contains is not an echo of the summary,
  /// so it is typed once instead of retyped into "66".
  @MainActor
  func testSingleDigitFillIntoDigitCountFieldIsTypedOnce() throws {
    try assertDigitCountFillIsUnconfirmed(code: "6", summary: "1 of 6 digits")
  }

  /// Fills the digit-count fixture field with `code` and asserts unconfirmed evidence and one entry.
  @MainActor
  private func assertDigitCountFillIsUnconfirmed(code: String, summary: String) throws {
    app.launchArguments = [
      "--agent-device-text-entry-regression",
      "--agent-device-text-entry-digit-count-value",
    ]
    app.launch()
    addTeardownBlock { [self] in
      invalidateCachedTarget(reason: "unit_test_cleanup")
      app.terminate()
    }
    let textField = app.textFields["agent-device-hardware-keyboard-input"]
    XCTAssertTrue(textField.waitForExistence(timeout: appExistenceTimeout))
    let frame = textField.frame
    let command = try JSONDecoder().decode(
      Command.self,
      from: JSONSerialization.data(withJSONObject: [
        "command": "type",
        "commandId": "fill-digit-count",
        "text": code,
        "textEntryMode": "replace",
        "x": frame.midX,
        "y": frame.midY,
        "appBundleId": "com.callstack.agentdevice.runner",
      ])
    )

    let failuresBeforeType = currentXCTestFailureCount()
    let response = executeTypeCommand(activeApp: app, command: command)

    XCTAssertFalse(didRecordXCTestFailure(since: failuresBeforeType))
    XCTAssertTrue(response.ok, String(describing: response.error))
    XCTAssertEqual(response.data?.message, "typed")
    XCTAssertEqual(response.data?.verification, "unconfirmed")
    XCTAssertEqual(response.data?.requested, code)
    XCTAssertEqual(response.data?.before, "0 of 6 digits")
    XCTAssertEqual(response.data?.after, summary)
    XCTAssertEqual(response.data?.target?.resourceId, "agent-device-hardware-keyboard-input")
    XCTAssertEqual(response.data?.target?.className, "TextField")
    XCTAssertEqual(response.data?.target?.packageName, "com.callstack.agentdevice.runner")
    XCTAssertEqual(app.staticTexts["agent-device-text-entry-digit-slots"].label, code)
  }
#endif
#endif
}
