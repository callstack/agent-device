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

  func testReplacementExactAndLiteralLossReadBack() {
    let cases: [(String, String, String, Bool)] = [
      ("", "123456", "123456", true),
      ("old", "123456", "123456", true),
      ("", "hello\n", "hello", true),
      ("", "123456", "12456", false),
      ("", "ada@example", "adxe", false),
      ("old", "123456", "old12345", false),
      ("0 of 6 digits", "123456", "0 of 6 digits", false),
      ("", "123456", "", false),
      ("$0.00", "5", "$0.05", false),
      ("", "hello ", "hello", false),
      ("", "", "residual", false),
    ]
    for (before, requested, after, verified) in cases {
      let result = Self.replacementTextEntryResult(
        requested: requested, baseline: Self.otpObservation(before), observed: Self.otpObservation(after)
      )
      XCTAssertEqual(result.verified, verified, "\(requested) -> \(after)")
      XCTAssertEqual(result.observedText, after)
      XCTAssertFalse(result.repaired)
      XCTAssertNil(result.unconfirmed)
    }
  }

  func testReplacementDisclosesNonLiteralValuesWithoutInferringCorrectness() {
    let cases: [(String, String, String)] = [
      ("", "000629177", "00 062 91 77"),
      ("", "000629177", "00 062 91 7"),
      ("", "000629177", "00 026 91 77"),
      ("", "5551234567", "(555) 123-4567"),
      ("12", "5551234567", "(555) 123-4567"),
      ("12", "5678", "12 567 8"),
      ("$0.00", "1000", "$10.00"),
      ("", "10.50", "1,050"),
      ("0 of 6 digits", "123456", "6 of 6 digits"),
      ("0 of 6 digits", "6", "1 of 6 digits"),
      ("", "6", "66"),
      ("", "123456", "old123456"),
    ]
    for (before, requested, after) in cases {
      let result = Self.replacementTextEntryResult(
        requested: requested, baseline: Self.otpObservation(before), observed: Self.otpObservation(after)
      )
      XCTAssertNil(result.verified, "\(requested) -> \(after)")
      XCTAssertFalse(result.repaired)
      XCTAssertNil(result.failure)
      XCTAssertEqual(result.unconfirmed, TextEntryUnconfirmedEvidence(
        requested: requested, before: before, after: after, target: Self.otpFieldIdentity
      ))
    }
  }

  func testReplacementEvidenceRequiresTheSameReadableTarget() {
    let otherField = TextEntryElementIdentity(identifier: "name-input", elementType: "TextField", frame: Self.otpFieldIdentity.frame)
    let differentTarget = Self.replacementTextEntryResult(
      requested: "123456", baseline: Self.otpObservation("0 of 6 digits"),
      observed: Self.otpObservation("6 of 6 digits", identity: otherField)
    )
    XCTAssertEqual(differentTarget.verified, false)
    XCTAssertNil(differentTarget.unconfirmed)
    let unreadableBefore = Self.replacementTextEntryResult(requested: "123456", baseline: nil, observed: Self.otpObservation("6 of 6 digits"))
    XCTAssertEqual(unreadableBefore.verified, false)
    XCTAssertNil(unreadableBefore.unconfirmed)
    let unreadableAfter = Self.replacementTextEntryResult(requested: "123456", baseline: Self.otpObservation(""), observed: nil)
    XCTAssertNil(unreadableAfter.verified)
    XCTAssertNil(unreadableAfter.unconfirmed)
  }

  func testReplacementSubmitDoesNotTreatMultilineContentAsASubmitKey() {
    let submitted = Self.replacementTextEntryResult(
      requested: "hello\n", baseline: Self.otpObservation(""), observed: Self.otpObservation("")
    )
    XCTAssertNil(submitted.verified)
    XCTAssertNil(submitted.unconfirmed)
    XCTAssertFalse(submitted.repaired)
    let textView = TextEntryElementIdentity(identifier: "message", elementType: elementTypeName(.textView), frame: Self.otpFieldIdentity.frame)
    for (after, expected) in [("hello", false), ("hello\n", true)] {
      let result = Self.replacementTextEntryResult(
        requested: "hello\n", baseline: Self.otpObservation("", identity: textView),
        observed: Self.otpObservation(after, identity: textView)
      )
      XCTAssertEqual(result.verified, expected)
      XCTAssertNil(result.unconfirmed)
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
  @MainActor
  func testFillWithAppWriteBackFailsWithoutRetyping() throws {
    app.launchArguments = [
      "--agent-device-text-entry-regression", "--agent-device-text-entry-app-owned-value",
      "--agent-device-text-entry-acknowledge-window", "10",
    ]
    app.launch()
    addTeardownBlock { [self] in
      invalidateCachedTarget(reason: "unit_test_cleanup")
      app.terminate()
    }
    let field = app.textFields["agent-device-hardware-keyboard-input"]
    XCTAssertTrue(field.waitForExistence(timeout: appExistenceTimeout))
    let frame = field.frame
    let text = "ada@example"
    let command = try JSONDecoder().decode(Command.self, from: JSONSerialization.data(withJSONObject: [
      "command": "type", "textEntryMode": "replace", "text": text,
      "x": frame.midX, "y": frame.midY, "appBundleId": "com.callstack.agentdevice.runner",
    ]))
    let failures = currentXCTestFailureCount()
    let response = executeTypeCommand(activeApp: app, command: command)
    XCTAssertFalse(didRecordXCTestFailure(since: failures))
    XCTAssertFalse(response.ok)
    XCTAssertEqual(response.error?.code, "TEXT_ENTRY_MISMATCH")
    XCTAssertEqual(field.value as? String, "a")
    let counters = app.staticTexts["agent-device-text-entry-write-backs"].label.split(separator: " ")
    XCTAssertTrue(counters.contains("total-edits=11"))
    XCTAssertTrue(counters.contains("write-backs=10"))
  }

  @MainActor
  func testFillIntoTemplateCurrencyFieldReportsUnconfirmedWithoutRetyping() throws {
    let field = try assertFillIntoNormalizingFieldIsUnconfirmed(
      fixtureFlag: "--agent-device-text-entry-currency-value",
      commandId: "fill-currency",
      text: "1000",
      expectedBefore: "$0.00",
      expectedAfter: "$10.00"
    )
    XCTAssertEqual(field.value as? String, "$10.00")
    XCTAssertEqual(app.staticTexts["agent-device-text-entry-events"].label, "4")
  }

  @MainActor
  func testFillThatClearsOnSubmitIsUnverifiedAndSubmitsOnce() throws {
    app.launchArguments = ["--agent-device-text-entry-regression", "--agent-device-text-entry-submit-clears"]
    app.launch()
    addTeardownBlock { [self] in
      invalidateCachedTarget(reason: "unit_test_cleanup")
      app.terminate()
    }
    let field = app.textFields["agent-device-hardware-keyboard-input"]
    XCTAssertTrue(field.waitForExistence(timeout: appExistenceTimeout))
    let frame = field.frame
    let command = try JSONDecoder().decode(Command.self, from: JSONSerialization.data(withJSONObject: [
      "command": "type", "textEntryMode": "replace", "text": "hello\n",
      "x": frame.midX, "y": frame.midY, "appBundleId": "com.callstack.agentdevice.runner",
    ]))
    let failures = currentXCTestFailureCount()
    let response = executeTypeCommand(activeApp: app, command: command)
    XCTAssertFalse(didRecordXCTestFailure(since: failures))
    XCTAssertTrue(response.ok, String(describing: response.error))
    XCTAssertEqual(response.data?.message, "typed")
    XCTAssertNil(response.data?.verification)
    XCTAssertEqual(field.value as? String, "")
    XCTAssertEqual(app.staticTexts["agent-device-text-entry-events"].label, "1")
  }

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

  @MainActor
  func testFillIntoDigitGroupingFieldReportsUnconfirmedEvidenceAndDoesNotRepair() throws {
    let textField = try assertFillIntoNormalizingFieldIsUnconfirmed(
      fixtureFlag: "--agent-device-text-entry-digit-grouping-value",
      commandId: "fill-digit-grouping",
      text: "000629177",
      expectedBefore: "",
      expectedAfter: "00 062 91 77"
    )
    // The field is left holding the digits the request carried, grouped: neither cleared out nor
    // doubled by a retype.
    let deadline = Date().addingTimeInterval(appExistenceTimeout)
    var observed: String?
    while Date() < deadline {
      observed = textField.value as? String
      if observed == "00 062 91 77" { break }
      Thread.sleep(forTimeInterval: 0.25)
    }
    XCTAssertEqual(observed, "00 062 91 77")
  }

  /// Fills the digit-count fixture field with `code` and asserts unconfirmed evidence and one entry.
  @MainActor
  private func assertDigitCountFillIsUnconfirmed(code: String, summary: String) throws {
    try assertFillIntoNormalizingFieldIsUnconfirmed(
      fixtureFlag: "--agent-device-text-entry-digit-count-value",
      commandId: "fill-digit-count",
      text: code,
      expectedBefore: "0 of 6 digits",
      expectedAfter: summary
    )
    // The slots an OTP screen renders next to its input carry the digits the field really holds.
    XCTAssertEqual(app.staticTexts["agent-device-text-entry-digit-slots"].label, code)
  }

  /// Launches the `--agent-device-text-entry-regression` field chosen by `fixtureFlag`, fills
  /// `text` through the daemon's `type`/replace command addressed at the field's center, and
  /// asserts the fill succeeded once with target-bound unconfirmed evidence carrying
  /// `expectedBefore`/`expectedAfter`. The field is returned for the caller's own after-entry
  /// oracle, which is the only thing that differs between the normalizing fixtures: a digit-count
  /// field's own value is a summary, a grouping field's is the formatted text.
  @MainActor
  @discardableResult
  private func assertFillIntoNormalizingFieldIsUnconfirmed(
    fixtureFlag: String,
    commandId: String,
    text: String,
    expectedBefore: String,
    expectedAfter: String
  ) throws -> XCUIElement {
    app.launchArguments = ["--agent-device-text-entry-regression", fixtureFlag]
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
        "commandId": commandId,
        "text": text,
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
    XCTAssertEqual(response.data?.requested, text)
    XCTAssertEqual(response.data?.before, expectedBefore)
    XCTAssertEqual(response.data?.after, expectedAfter)
    XCTAssertEqual(response.data?.target?.resourceId, "agent-device-hardware-keyboard-input")
    XCTAssertEqual(response.data?.target?.className, "TextField")
    XCTAssertEqual(response.data?.target?.packageName, "com.callstack.agentdevice.runner")
    return textField
  }
#endif
#endif
}
