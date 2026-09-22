import ApplicationServices
import XCTest
@testable import AgentDeviceMacOSDeviceHub

final class DeviceHubWindowInventoryTests: XCTestCase {
  func testLaterWindowKeepsItsProcessAndDoesNotPreventEmptyProcessReopen() {
    var inventory = DeviceHubWindowInventory()
    let window = AXUIElementCreateApplication(20)
    inventory.record(processID: 10, read: .available([]))
    inventory.record(processID: 20, read: .available([window]))
    XCTAssertEqual(inventory.candidates.map(\.processID), [20])
    XCTAssertTrue(CFEqual(inventory.candidates[0].window, window))
    inventory.record(candidate: 0, outcome: .sidebarUnavailable)
    XCTAssertEqual(inventory.processesToReopen(attempted: []), [10])
    XCTAssertEqual(inventory.failureReason(), "device-hub-identity-unconfirmed")
    XCTAssertEqual(inventory.candidateOutcomes, ["20:0:sidebar-unavailable"])
  }

  func testFailedReadsAreNotReopenedOrMisreportedAsMissingWindows() {
    var inventory = DeviceHubWindowInventory()
    inventory.record(processID: 10, read: .failed(-25204))
    inventory.record(processID: 20, read: .available([]))
    XCTAssertEqual(inventory.processesToReopen(attempted: []), [20])
    XCTAssertEqual(inventory.failures, [10: -25204])
    XCTAssertEqual(inventory.failureReason(), "device-hub-window-read-failed")
  }

  func testSuccessfulEmptyReadIsMissingAndReopenIsAttemptedOnlyOnce() {
    var inventory = DeviceHubWindowInventory()
    inventory.record(processID: 10, read: .available([]))
    XCTAssertEqual(inventory.failureReason(), "device-hub-window-missing")
    XCTAssertEqual(inventory.processesToReopen(attempted: []), [10])
    XCTAssertEqual(inventory.processesToReopen(attempted: [10]), [])
  }

  func testSharedBudgetExhaustionStopsReopenWithoutClaimingMissingDevice() {
    var inventory = DeviceHubWindowInventory()
    inventory.record(processID: 10, read: .available([]))
    inventory.expireBudget()
    XCTAssertEqual(inventory.processesToReopen(attempted: []), [])
    XCTAssertEqual(inventory.failureReason(), "device-hub-discovery-timeout")
  }

  func testCandidateOutcomesRetainUncertaintyAndOwningProcess() {
    var inventory = DeviceHubWindowInventory()
    inventory.record(processID: 10, read: .available([AXUIElementCreateApplication(10)]))
    inventory.record(processID: 20, read: .available([AXUIElementCreateApplication(20)]))
    inventory.record(candidate: 0, outcome: .timedOut)
    inventory.record(candidate: 1, outcome: .unconfirmed)
    XCTAssertEqual(inventory.candidateOutcomes, ["10:0:timed-out", "20:1:row-unconfirmed"])
    XCTAssertEqual(inventory.failureReason(), "device-hub-identity-unconfirmed")
  }
  func testUnrelatedReopenFailureDoesNotMaskCandidateUncertainty() {
    var inventory = DeviceHubWindowInventory()
    inventory.record(processID: 10, read: .available([]))
    let failures: [Int32: String] = [10: "automation-permission"]
    XCTAssertEqual(inventory.failureReason(reopenFailures: failures), "automation-permission")
    inventory.record(processID: 20, read: .available([AXUIElementCreateApplication(20)]))
    inventory.record(candidate: 0, outcome: .timedOut)
    XCTAssertEqual(inventory.failureReason(reopenFailures: failures), "device-hub-identity-unconfirmed")
    inventory.expireBudget()
    XCTAssertEqual(inventory.failureReason(reopenFailures: failures), "device-hub-discovery-timeout")
  }

}
