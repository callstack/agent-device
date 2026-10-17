import XCTest

@testable import AgentDeviceMacOSHelper

final class RectResponseTests: XCTestCase {
  func testFiniteRectKeepsItsValues() throws {
    let rect = try XCTUnwrap(
      finiteRectResponse(position: CGPoint(x: 1, y: 2), size: CGSize(width: 3, height: 4)))
    XCTAssertEqual([rect.x, rect.y, rect.width, rect.height], [1, 2, 3, 4])
  }

  func testNonFiniteComponentYieldsNoRect() {
    let nonFinite: [CGFloat] = [.infinity, -.infinity, .nan]
    for value in nonFinite {
      XCTAssertNil(finiteRectResponse(position: CGPoint(x: value, y: 0), size: .zero))
      XCTAssertNil(finiteRectResponse(position: CGPoint(x: 0, y: value), size: .zero))
      XCTAssertNil(finiteRectResponse(position: .zero, size: CGSize(width: value, height: 0)))
      XCTAssertNil(finiteRectResponse(position: .zero, size: CGSize(width: 0, height: value)))
    }
  }
}
