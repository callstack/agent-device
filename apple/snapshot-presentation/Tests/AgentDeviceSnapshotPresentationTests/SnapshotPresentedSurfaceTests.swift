import AgentDeviceSnapshotPresentation
import Foundation
import XCTest

/// Cross-language parity for the presented-surface rule (#3565): the golden table
/// `contracts/fixtures/ios-presented-surface.json` is the source of truth, and this test runs every case
/// in it through `SnapshotPresentedSurface.classify` twice — once with the UIKit class names the table
/// spells, once with every class name stripped, which is what a capture from a producer that reports no
/// class names looks like. The stripped reading is the one an XCTest runner tree has, and it is what the
/// table's `classBlindExpected` states.
final class SnapshotPresentedSurfaceTests: XCTestCase {
  private struct Vocabulary: Decodable {
    let presentationContainerClass: String
    let dimmingViewClass: String
    let alertRootClassPrefix: String
    let systemWindowClasses: [String]
    let presentingElementTypes: [PresentingElementType]
  }

  private struct PresentingElementType: Decodable {
    let name: String
    let elementType: Int
  }

  private struct Node: Decodable {
    let index: Int
    let parentIndex: Int?
    let type: String
    let role: String?
  }

  private struct FixtureCase: Decodable {
    let name: String
    let truncated: Bool?
    let expected: String
    let classBlindExpected: String
    let nodes: [Node]
  }

  private struct Fixture: Decodable {
    let vocabulary: Vocabulary
    let cases: [FixtureCase]
  }

  private func readFixture() throws -> Fixture {
    let url = contractsFixtureURL("ios-presented-surface.json")
    return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
  }

  func testVocabularyMatchesTheGoldenTable() throws {
    let vocabulary = try readFixture().vocabulary
    XCTAssertEqual(vocabulary.presentationContainerClass, SnapshotPresentedSurface.presentationContainerClass)
    XCTAssertEqual(vocabulary.dimmingViewClass, SnapshotPresentedSurface.dimmingViewClass)
    XCTAssertEqual(vocabulary.alertRootClassPrefix, SnapshotPresentedSurface.alertRootClassPrefix)
    XCTAssertEqual(Set(vocabulary.systemWindowClasses), SnapshotPresentedSurface.systemWindowClasses)
    XCTAssertEqual(
      Dictionary(uniqueKeysWithValues: vocabulary.presentingElementTypes.map { ($0.name, $0.elementType) }),
      SnapshotPresentedSurface.presentingElementTypes
    )
  }

  func testEveryCaseClassifiesAsTheGoldenTableStates() throws {
    for testCase in try readFixture().cases {
      let nodes = testCase.nodes.map {
        PresentedSurfaceNode(index: $0.index, parentIndex: $0.parentIndex, elementType: $0.type, className: $0.role)
      }
      let completeness = completeness(of: testCase)
      XCTAssertEqual(
        SnapshotPresentedSurface.classify(nodes: nodes, completeness: completeness),
        presentedSurface(testCase.expected),
        "\(testCase.name): class-aware reading"
      )
      let classBlind = nodes.map {
        PresentedSurfaceNode(index: $0.index, parentIndex: $0.parentIndex, elementType: $0.elementType, className: nil)
      }
      XCTAssertEqual(
        SnapshotPresentedSurface.classify(nodes: classBlind, completeness: completeness),
        presentedSurface(testCase.classBlindExpected),
        "\(testCase.name): class-blind reading"
      )
    }
  }

  /// The producer's own completeness claim, which the table states as `truncated`: a null is a producer
  /// that observes nothing about truncation, and cannot be read as "complete".
  private func completeness(of testCase: FixtureCase) -> PresentedSurfaceCompleteness {
    guard let truncated = testCase.truncated else { return .unstated }
    return truncated ? .capped : .complete
  }

  private func presentedSurface(_ raw: String) -> PresentedSurface {
    guard let value = PresentedSurface(rawValue: raw) else {
      XCTFail("unknown expected state in the golden table: \(raw)")
      return .unknown
    }
    return value
  }

  /// Completeness decides the absence half of the rule, and only a class-aware tree can reach that half:
  /// the branch needs the window structure a UIKit class name states. So this is where the producer's
  /// claim is pinned, on the table's ordinary screen — `absent` when the producer says the capture is
  /// whole, `unknown` once it reports a cap or never looked.
  func testCompletenessDecidesOnlyTheAbsenceHalf() throws {
    let ordinary = try XCTUnwrap(try readFixture().cases.first { $0.name == "home, one container per window" })
    let nodes = ordinary.nodes.map {
      PresentedSurfaceNode(index: $0.index, parentIndex: $0.parentIndex, elementType: $0.type, className: $0.role)
    }
    XCTAssertEqual(SnapshotPresentedSurface.classify(nodes: nodes, completeness: .complete), .absent)
    XCTAssertEqual(SnapshotPresentedSurface.classify(nodes: nodes, completeness: .capped), .unknown)
    XCTAssertEqual(SnapshotPresentedSurface.classify(nodes: nodes, completeness: .unstated), .unknown)
  }

  /// The runner entry point takes an acquisition, and `RawAXNode` carries no UIKit class name, so every
  /// reading through it is class-blind and can never earn `absent` — that is the coverage gap the fact
  /// discloses, not a case to be coaxed out with a different completeness flag. What this pins is that the
  /// producer's own positive evidence still answers through it, cap or no cap.
  func testAcquisitionEntryAnswersOnPositiveEvidenceAlone() throws {
    let alert = try XCTUnwrap(
      try readFixture().cases.first { $0.name == "the same alert through a producer whose name table stops short" }
    )
    func acquisition(truncated: Bool) -> SnapshotAcquisition {
      SnapshotAcquisition(
        hint: SnapshotPresentation.captureHint(
          for: PresentationOptions(interactiveOnly: false, depth: nil, scope: nil, raw: true)
        ),
        nodes: alert.nodes.map {
          RawAXNode(
            index: $0.index,
            type: $0.type,
            label: nil,
            identifier: nil,
            value: nil,
            rect: SnapshotRect(x: 0, y: 0, width: 10, height: 10),
            enabled: true,
            focused: nil,
            selected: nil,
            hittable: nil,
            depth: 0,
            parentIndex: $0.parentIndex,
            hiddenContentAbove: nil,
            hiddenContentBelow: nil
          )
        },
        truncated: truncated,
        effectiveDepth: nil,
        viewport: .reported(box: CGRect(x: 0, y: 0, width: 100, height: 200))
      )
    }

    XCTAssertEqual(SnapshotPresentedSurface.classify(acquisition(truncated: false)), .presented)
    XCTAssertEqual(SnapshotPresentedSurface.classify(acquisition(truncated: true)), .presented)
  }
}
