import Foundation
import XCTest

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
private struct AlertCommandTraitsFixture: Decodable {
  let name: String
  let command: Command
  let readOnly: Bool
}

extension RunnerTests {
  func testAlertReadOnlyClassificationMatchesGoldenTable() throws {
    let fixtureURL = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .appendingPathComponent("contracts/fixtures/alert-command-traits.json")
    let cases = try JSONDecoder().decode(
      [AlertCommandTraitsFixture].self,
      from: Data(contentsOf: fixtureURL)
    )
    XCTAssertEqual(cases.map { $0.command.action }, [nil, "get", "accept", "dismiss"])
    for fixture in cases {
      XCTAssertEqual(isReadOnlyCommand(fixture.command), fixture.readOnly, fixture.name)
    }
  }
}
#endif
