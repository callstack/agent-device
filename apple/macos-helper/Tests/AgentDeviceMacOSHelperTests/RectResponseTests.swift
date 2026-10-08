import XCTest

@testable import AgentDeviceMacOSHelper

final class RectResponseTests: XCTestCase {
  func testFiniteRectKeepsItsValues() throws {
    let rect = try XCTUnwrap(RectResponse(finiteX: 1, y: 2, width: 3, height: 4))
    XCTAssertEqual([rect.x, rect.y, rect.width, rect.height], [1, 2, 3, 4])
  }

  func testNonFiniteComponentYieldsNoRect() {
    XCTAssertNil(RectResponse(finiteX: .infinity, y: .infinity, width: 0, height: 0))
    XCTAssertNil(RectResponse(finiteX: 0, y: -.infinity, width: 0, height: 0))
    XCTAssertNil(RectResponse(finiteX: 0, y: 0, width: .nan, height: 0))
    XCTAssertNil(RectResponse(finiteX: 0, y: 0, width: 0, height: .infinity))
  }

  func testUnguardedInfiniteRectFailsEncoding() {
    XCTAssertThrowsError(
      try JSONEncoder().encode(RectResponse(x: .infinity, y: 0, width: 0, height: 0)))
  }
}
