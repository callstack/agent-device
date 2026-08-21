import XCTest

extension RunnerTests {
  func privateAXInteractiveCandidate(rawElementType: Int) -> Bool {
    guard let type = privateAXElementType(rawElementType: rawElementType) else {
      return false
    }
    return interactiveTypes.contains(type) || Self.scrollContainerTypes.contains(type)
  }

  func privateAXElementType(rawElementType: Int) -> XCUIElement.ElementType? {
    guard let raw = UInt(exactly: rawElementType),
      let type = XCUIElement.ElementType(rawValue: raw)
    else {
      return nil
    }
    return type
  }

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
  func testPrivateAXInteractiveCandidatesPreserveBackendInputs() {
    XCTAssertTrue(
      privateAXInteractiveCandidate(rawElementType: Int(XCUIElement.ElementType.scrollView.rawValue)),
      "private AX marks scroll containers as interactive candidates"
    )
  }
#endif
}
