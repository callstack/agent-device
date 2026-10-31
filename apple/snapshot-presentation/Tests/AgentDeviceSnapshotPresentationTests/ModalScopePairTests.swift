import CoreGraphics
import XCTest
@testable import AgentDeviceSnapshotPresentation

final class ModalScopePairTests: XCTestCase {
  private let screen = CGRect(x: 0, y: 0, width: 402, height: 874)
  private let button = CGRect(x: 360, y: 60, width: 38, height: 38)

  private func node(_ element: String, _ parent: String?, _ frame: CGRect? = nil) -> ModalScopeNode {
    ModalScopeNode(element: element, parentElement: parent, frame: frame ?? screen)
  }

  // A sheet: the honor-modal read keeps the app, its window, and the sheet, and drops the page
  // the sheet covers. The sheet's close button is exposed under two parents in both reads.
  private var plain: [ModalScopeNode] {
    [
      node("1:0.1", nil),
      node("1:10.2", "1:0.1"),
      node("1:20.3", "1:10.2"),
      node("1:21.4", "1:20.3"),
      node("1:30.5", "1:10.2"),
      node("1:31.6", "1:30.5", button),
      node("1:32.7", "1:30.5"),
      node("1:31.6", "1:32.7", button),
    ]
  }

  private func pair(_ honorModal: [ModalScopeNode]) -> ModalScopePairing {
    ModalScopePair.pair(plain: plain, honorModal: honorModal, confirmingHonorModal: honorModal)
  }

  func testAnHonorModalSubsetPairsAndCountsTheRemovedNodes() {
    let honorModal = plain.filter { !["1:20.3", "1:21.4"].contains($0.element) }
    XCTAssertEqual(pair(honorModal), .paired(removedNodeCount: 2))
  }

  func testAnIdenticalReadPairsWithNothingRemoved() {
    XCTAssertEqual(pair(plain), .paired(removedNodeCount: 0))
  }

  func testAnElementTheHonorModalReadAloneHasIsUnmatched() {
    let honorModal = plain + [node("1:40.8", "1:30.5")]
    XCTAssertEqual(pair(honorModal), .unstable(.unmatchedElement))
  }

  func testAKnownElementUnderAnotherParentIsReparented() {
    let honorModal = Array(plain.prefix(5)) + [node("1:21.4", "1:30.5")]
    XCTAssertEqual(pair(honorModal), .unstable(.reparentedElement))
  }

  func testAnElementListedMoreOftenUnderOneParentThanInThePlainReadIsReparented() {
    let honorModal = plain + [node("1:31.6", "1:32.7", button)]
    XCTAssertEqual(pair(honorModal), .unstable(.reparentedElement))
  }

  func testAnElementWithAnotherFrameMoved() {
    var honorModal = plain
    honorModal[5] = node("1:31.6", "1:30.5", button.offsetBy(dx: 0, dy: 4))
    XCTAssertEqual(pair(honorModal), .unstable(.movedElement))
  }

  // The sheet is dismissed after the first honor-modal read: the plain read and the second
  // honor-modal read show the whole page, and the first honor-modal read is still a subset.
  func testAModalDismissedBetweenTheReadsChangedTheScreen() {
    let sheetOnly = plain.filter { !["1:20.3", "1:21.4"].contains($0.element) }
    XCTAssertEqual(
      ModalScopePair.pair(plain: plain, honorModal: sheetOnly, confirmingHonorModal: plain),
      .unstable(.screenChanged)
    )
  }
}
