import AgentDeviceSnapshotPresentation
import Foundation
import XCTest

/// Cross-language parity for the presented-surface rule (#3565): every case in
/// `contracts/fixtures/ios-presented-surface.json` runs through the runner entry point, which reads no
/// class names, so each must answer the table's `classBlindExpected`.
final class SnapshotPresentedSurfaceTests: XCTestCase {
  private struct Vocabulary: Decodable {
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
  }

  private struct FixtureCase: Decodable {
    let name: String
    let truncated: Bool?
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
    XCTAssertEqual(
      Dictionary(uniqueKeysWithValues: vocabulary.presentingElementTypes.map { ($0.name, $0.elementType) }),
      SnapshotPresentedSurface.presentingElementTypes
    )
  }

  func testEveryCaseClassifiesAsTheGoldenTableStatesForAClassBlindProducer() throws {
    let cases = try readFixture().cases
    XCTAssertFalse(cases.isEmpty)
    for testCase in cases {
      XCTAssertEqual(
        SnapshotPresentedSurface.classify(acquisition(of: testCase)),
        try XCTUnwrap(PresentedSurface(rawValue: testCase.classBlindExpected)),
        testCase.name
      )
    }
  }

  func testACapDoesNotDefeatPositiveEvidence() throws {
    let alert = try XCTUnwrap(
      try readFixture().cases.first { $0.name == "the same alert through a producer whose name table stops short" }
    )
    XCTAssertEqual(SnapshotPresentedSurface.classify(acquisition(of: alert, truncated: false)), .presented)
    XCTAssertEqual(SnapshotPresentedSurface.classify(acquisition(of: alert, truncated: true)), .presented)
  }

  private func acquisition(of testCase: FixtureCase, truncated: Bool? = nil) -> SnapshotAcquisition {
    SnapshotAcquisition(
      hint: SnapshotPresentation.captureHint(
        for: PresentationOptions(interactiveOnly: false, depth: nil, scope: nil, raw: true)
      ),
      nodes: testCase.nodes.map {
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
      truncated: truncated ?? testCase.truncated ?? false,
      effectiveDepth: nil,
      viewport: .reported(box: CGRect(x: 0, y: 0, width: 100, height: 200))
    )
  }
}
