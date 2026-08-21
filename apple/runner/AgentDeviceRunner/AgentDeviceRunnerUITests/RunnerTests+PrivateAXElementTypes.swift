import XCTest

extension RunnerTests {
  func privateAXElementType(rawElementType: Int) -> XCUIElement.ElementType? {
    guard let raw = UInt(exactly: rawElementType),
      let type = XCUIElement.ElementType(rawValue: raw)
    else {
      return nil
    }
    return type
  }
}
