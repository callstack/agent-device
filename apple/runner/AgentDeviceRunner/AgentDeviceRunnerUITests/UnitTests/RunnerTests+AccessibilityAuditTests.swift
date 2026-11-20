import XCTest

#if AGENT_DEVICE_RUNNER_UNIT_TESTS && os(iOS)
extension RunnerTests {
  func testNativeAuditTypeNamesPreserveAppleTypes() throws {
    if #available(iOS 17.0, *) {
      let cases: [(XCUIAccessibilityAuditType, String)] = [
        (.contrast, "contrast"), (.dynamicType, "dynamicType"),
        (.elementDetection, "elementDetection"), (.hitRegion, "hitRegion"),
        (.sufficientElementDescription, "sufficientElementDescription"),
        (.textClipped, "textClipped"), (.trait, "trait"),
      ]
      for (type, name) in cases {
        XCTAssertEqual(nativeAuditTypeName(type), name)
      }
      XCTAssertEqual(nativeAuditTypeName(XCUIAccessibilityAuditType(rawValue: 16)), "unknown:16")
    }
  }

  func testNativeAuditPayloadEncodesPointsAndMissingElement() throws {
    let payload = DataPayload(auditIssues: [
      NativeAuditIssuePayload(auditType: "contrast", description: "Low contrast",
        rect: NativeAuditRect(x: 10.5, y: 20, width: 30, height: 40)),
      NativeAuditIssuePayload(auditType: "dynamicType", description: "Does not scale", rect: nil),
    ])
    let data = try JSONEncoder().encode(payload)
    let decoded = try JSONDecoder().decode(DataPayload.self, from: data)
    XCTAssertEqual(decoded.auditIssues?.count, 2)
    XCTAssertEqual(decoded.auditIssues?[0].rect?.x, 10.5)
    XCTAssertEqual(decoded.auditIssues?[0].description, "Low contrast")
    XCTAssertNil(decoded.auditIssues?[1].rect)
  }
}
#endif
