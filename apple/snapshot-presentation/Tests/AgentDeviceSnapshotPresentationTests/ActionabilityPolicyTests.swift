import AgentDeviceSnapshotPresentation
import CoreGraphics
import Foundation
import XCTest

/// Golden vector table for the shared `hittable` predicate (#2891). The same
/// `contracts/fixtures/snapshot-actionability-policy.json` rows are replayed against the TypeScript
/// twin (`isGeometricallyActionable` in `packages/kernel/src/rect.ts`) by
/// `scripts/ios-snapshot-differential.test.ts`, so drift between the runner's Swift rule and the
/// host's reads red on whichever side moved.
final class ActionabilityPolicyTests: XCTestCase {
  private struct Table: Decodable {
    let description: String
    let cases: [PolicyCase]
  }

  /// A rect as JSON can carry one. Infinity has no JSON spelling, so the two unusable boxes a platform
  /// can hand back are named: `{"infinite": true}` is `CGRect.infinite`, the box Apple returns for
  /// "resolved none" (`window-coordinate-space.json` spells it the same), and `{"nonFinite": true}` is
  /// a box with actual infinite components, which is what the host's frame decoder refuses.
  private struct RectBox: Decodable {
    private enum CodingKeys: String, CodingKey {
      case x, y, width, height, infinite, nonFinite
    }

    let cgRect: CGRect

    init(from decoder: Decoder) throws {
      let container = try decoder.container(keyedBy: CodingKeys.self)
      guard try container.decodeIfPresent(Bool.self, forKey: .infinite) != true else {
        self.cgRect = .infinite
        return
      }
      guard try container.decodeIfPresent(Bool.self, forKey: .nonFinite) != true else {
        self.cgRect = CGRect(
          x: -.infinity,
          y: -.infinity,
          width: .infinity,
          height: .infinity
        )
        return
      }
      self.cgRect = CGRect(
        x: try container.decode(Double.self, forKey: .x),
        y: try container.decode(Double.self, forKey: .y),
        width: try container.decode(Double.self, forKey: .width),
        height: try container.decode(Double.self, forKey: .height)
      )
    }
  }

  /// The viewport as the three-case fact it crosses the boundary as. A row declaring `reported` or
  /// `derived` has to survive the declaration factories with that kind intact, so the table cannot
  /// quietly start exercising the `missing` policy under a reported label.
  private struct ViewportFact: Decodable {
    private enum CodingKeys: String, CodingKey {
      case kind, rect, reason
    }

    let declaredKind: String
    let viewport: SnapshotViewport

    /// A row labelled `reported` whose box cannot be a viewport would silently start testing the
    /// `missing` policy, so the declaration has to come back with the kind the row names.
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
        self.viewport = .reported(box: try container.decode(RectBox.self, forKey: .rect).cgRect)
      case "derived":
        self.viewport = .derived(box: try container.decode(RectBox.self, forKey: .rect).cgRect)
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
    private enum CodingKeys: String, CodingKey {
      case name, swift, typescript, asymmetry, enabled, node, viewport, hittable, nodeRectGuardPasses
    }

    let name: String
    let swift: Bool
    let typescript: Bool
    let asymmetry: String?
    let enabled: Bool
    let node: RectBox
    let viewport: ViewportFact
    let hittable: Bool
    let nodeRectGuardPasses: Bool

    /// A row one language skips is a written-down divergence, and a divergence without a reason is how
    /// two implementations start disagreeing quietly again: a shared row carries no reason and a skipped
    /// row carries exactly one.
    var declaresItsAsymmetry: Bool {
      (swift && typescript) != (asymmetry?.isEmpty == false)
    }
  }

  func testActionabilityPolicyAgreesWithEveryGoldenVector() throws {
    let table = try loadActionabilityPolicyTable()
    XCTAssertFalse(table.cases.isEmpty, "vector table must not be empty")
    XCTAssertEqual(
      Set(table.cases.map(\.name)).count,
      table.cases.count,
      "vector names must be unique"
    )
    for testCase in table.cases {
      XCTAssertTrue(
        testCase.declaresItsAsymmetry,
        "\(testCase.name): a row both languages do not share must name the asymmetry"
      )
      guard testCase.swift else { continue }
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

  /// The table cannot be trimmed until the unknown-viewport policy is the only thing left untested:
  /// every declared kind has to be present, and no `missing` row may rest on a node rect that the
  /// guard already refuses — that would make the row's `false` say nothing about the policy.
  func testActionabilityPolicyCoversEveryViewportKindWithoutAVacuousMissingRow() throws {
    let cases = try loadActionabilityPolicyTable().cases.filter(\.swift)
    XCTAssertEqual(Set(cases.map(\.viewport.declaredKind)), ["reported", "derived", "missing"])
    for testCase in cases where testCase.viewport.declaredKind == "missing" {
      XCTAssertTrue(
        testCase.nodeRectGuardPasses,
        "\(testCase.name): a missing-viewport row must have a node the guard accepts"
      )
    }
  }

  private func loadActionabilityPolicyTable() throws -> Table {
    let tableURL = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent() // AgentDeviceSnapshotPresentationTests
      .deletingLastPathComponent() // Tests
      .deletingLastPathComponent() // snapshot-presentation
      .deletingLastPathComponent() // apple
      .deletingLastPathComponent() // repo root
      .appendingPathComponent("contracts")
      .appendingPathComponent("fixtures")
      .appendingPathComponent("snapshot-actionability-policy.json")
    return try JSONDecoder().decode(Table.self, from: Data(contentsOf: tableURL))
  }
}
