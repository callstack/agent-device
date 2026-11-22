import XCTest

@testable import AgentDeviceMacOSHelper

/// `captureSurfaceScreenshot` always reads the main display, so the response describes only
/// what was actually captured: no field for an argument the helper does not read.
final class ScreenshotResponseTests: XCTestCase {
  func testResponseNeverCarriesAFullscreenField() throws {
    let response = ScreenshotResponse(path: "/tmp/out.png", surface: "desktop")
    let data = try JSONEncoder().encode(response)
    let decoded = try JSONSerialization.jsonObject(with: data) as? [String: Any]

    XCTAssertEqual(Set(decoded?.keys.map { $0 } ?? []), ["path", "surface"])
  }
}
