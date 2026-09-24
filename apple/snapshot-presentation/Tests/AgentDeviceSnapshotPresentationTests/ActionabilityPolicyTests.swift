import AgentDeviceSnapshotPresentation
import CoreGraphics
import Foundation
import XCTest

/// Replays `contracts/fixtures/snapshot-actionability-policy.json` against the Swift predicate. The
/// TypeScript twin replays the same rows in `scripts/ios-snapshot-differential.test.ts`.
final class ActionabilityPolicyTests: XCTestCase {
  private struct Table: Decodable {
    let cases: [PolicyCase]
  }

  private struct ViewportFact: Decodable {
    private enum CodingKeys: String, CodingKey {
      case kind, rect, reason
    }

    let declaredKind: String
    let viewport: SnapshotViewport

    /// A row whose box the factory refuses would silently test `missing` under another label.
    var matchesDeclaredKind: Bool {
      switch (declaredKind, viewport) {
      case ("reported", .reported), ("derived", .derived), ("missing", .missing):
        return true
      default:
        return false
      }
    }

    init(from decoder: Decoder) throws {
      let container = try decoder.container(keyedBy: CodingKeys.self)
      let kind = try container.decode(String.self, forKey: .kind)
      self.declaredKind = kind
      switch kind {
      case "reported":
        self.viewport = .reported(box: try container.decode(FixtureRect.self, forKey: .rect).cgRect)
      case "derived":
        self.viewport = .derived(box: try container.decode(FixtureRect.self, forKey: .rect).cgRect)
      case "missing":
        switch try container.decode(String.self, forKey: .reason) {
        case "not-provided":
          self.viewport = .missing(reason: .notProvided)
        case "invalid":
          self.viewport = .missing(reason: .invalid)
        default:
          throw DecodingError.dataCorruptedError(
            forKey: .reason,
            in: container,
            debugDescription: "unknown missing-viewport reason"
          )
        }
      default:
        throw DecodingError.dataCorruptedError(
          forKey: .kind,
          in: container,
          debugDescription: "unknown viewport kind"
        )
      }
    }
  }

  private struct PolicyCase: Decodable {
    let name: String
    let swift: Bool
    let typescript: Bool
    let asymmetry: String?
    let enabled: Bool
    let node: FixtureRect
    let viewport: ViewportFact
    /// `nil` is the absent bit.
    let hittable: Bool?
    let nodeRectGuardPasses: Bool

    var declaresItsAsymmetry: Bool {
      (swift && typescript) != (asymmetry?.isEmpty == false)
    }
  }

  func testActionabilityPolicyAgreesWithEveryGoldenVector() throws {
    let table = try JSONDecoder().decode(
      Table.self,
      from: Data(contentsOf: contractsFixtureURL("snapshot-actionability-policy.json"))
    )
    XCTAssertEqual(Set(table.cases.map(\.name)).count, table.cases.count, "names must be unique")
    let swiftCases = table.cases.filter(\.swift)
    XCTAssertEqual(
      Set(swiftCases.map(\.viewport.declaredKind)),
      ["reported", "derived", "missing"]
    )
    for testCase in table.cases {
      XCTAssertTrue(
        testCase.declaresItsAsymmetry,
        "\(testCase.name): a row both languages do not share must name the asymmetry"
      )
    }
    for testCase in swiftCases {
      XCTAssertTrue(
        testCase.viewport.matchesDeclaredKind,
        "\(testCase.name): declared \(testCase.viewport.declaredKind) must survive declaration"
      )
      XCTAssertEqual(
        SnapshotGeometry.isPositiveFinite(testCase.node.cgRect),
        testCase.nodeRectGuardPasses,
        "\(testCase.name): node-rect guard"
      )
      XCTAssertEqual(
        SnapshotGeometry.isGeometricallyActionable(
          enabled: testCase.enabled,
          frame: testCase.node.cgRect,
          viewport: testCase.viewport.viewport
        ),
        testCase.hittable,
        testCase.name
      )
    }
  }
}
