import XCTest

@testable import AgentDeviceMacOSDeviceHub

final class DeviceHubPoseTests: XCTestCase {
  func testEveryPoseNamesTheActionBarControlDeviceHubDescribes() {
    XCTAssertEqual(DeviceHubPose(argument: "closed")?.controlDescription, "Closed")
    XCTAssertEqual(DeviceHubPose(argument: "book")?.controlDescription, "Book")
    XCTAssertEqual(DeviceHubPose(argument: "OPEN")?.controlDescription, "Open")
    XCTAssertNil(DeviceHubPose(argument: "half-open"), "the helper takes Device Hub's names, not the CLI's")
    XCTAssertEqual(Set(DeviceHubPose.allCases.map(\.controlDescription)), ["Closed", "Book", "Open"])
  }

  // Device Hub titles the window `<name> – iOS 27.1`; a simulator whose name merely starts
  // with another's must not claim that window.
  func testWindowTitleMatchesTheDeviceNameAsAPrefixWord() {
    XCTAssertTrue(deviceHubWindowShows(deviceName: "iPhone Duo", title: "iPhone Duo – iOS 27.1"))
    XCTAssertTrue(deviceHubWindowShows(deviceName: "iPhone Duo", title: "iPhone Duo"))
    XCTAssertFalse(deviceHubWindowShows(deviceName: "iPhone Duo", title: "iPhone Duo Lab – iOS 27.1"))
    XCTAssertFalse(deviceHubWindowShows(deviceName: "iPhone Duo", title: "bench-golden-v1 – iOS 27.0"))
    XCTAssertFalse(deviceHubWindowShows(deviceName: "iPhone Duo", title: nil))
  }

  func testSidebarRowIsKeyedByUdid() {
    XCTAssertEqual(
      deviceHubDeviceRowIdentifier(udid: "4F879835-4AB3-4046-B033-5AB769209DD4"),
      "TableRow.Device.4F879835-4AB3-4046-B033-5AB769209DD4"
    )
  }
}
