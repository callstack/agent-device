import CoreGraphics
import Foundation

/// A rect as a `contracts/fixtures/` table spells it. JSON has no infinity, so the two unusable
/// boxes are named: `{"infinite": true}` is `CGRect.infinite`, and `{"nonFinite": true}` is a
/// box whose components are infinite.
struct FixtureRect: Decodable {
  private enum CodingKeys: String, CodingKey {
    case x, y, width, height, infinite, nonFinite
  }

  let cgRect: CGRect

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    if try container.decodeIfPresent(Bool.self, forKey: .infinite) == true {
      self.cgRect = .infinite
    } else if try container.decodeIfPresent(Bool.self, forKey: .nonFinite) == true {
      self.cgRect = CGRect(x: -.infinity, y: -.infinity, width: .infinity, height: .infinity)
    } else {
      self.cgRect = CGRect(
        x: try container.decode(Double.self, forKey: .x),
        y: try container.decode(Double.self, forKey: .y),
        width: try container.decode(Double.self, forKey: .width),
        height: try container.decode(Double.self, forKey: .height)
      )
    }
  }
}

func contractsFixtureURL(_ name: String, from filePath: String = #filePath) -> URL {
  URL(fileURLWithPath: filePath)
    .deletingLastPathComponent() // AgentDeviceSnapshotPresentationTests
    .deletingLastPathComponent() // Tests
    .deletingLastPathComponent() // snapshot-presentation
    .deletingLastPathComponent() // apple
    .deletingLastPathComponent() // repo root
    .appendingPathComponent("contracts")
    .appendingPathComponent("fixtures")
    .appendingPathComponent(name)
}
