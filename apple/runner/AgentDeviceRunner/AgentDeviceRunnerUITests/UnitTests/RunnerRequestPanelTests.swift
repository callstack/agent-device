import XCTest

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
extension RunnerTests {
  /// One runner process can serve a foldable's `tap` and then a single-panel request; the second
  /// must not resolve against the first's panel.
  func testRequestPanelFollowsTheCommandAndAnUnnamedPanelClearsIt() throws {
    setRequestLitPanel(from: try command(namingLitPanel: #"{"displayId":3,"widthPt":669,"heightPt":951}"#))
    XCTAssertEqual(requestSurfacePanel?.displayID, 3)
    XCTAssertEqual(requestSurfacePanel?.widthPt, 669)
    XCTAssertEqual(requestSurfacePanel?.heightPt, 951)

    setRequestLitPanel(from: try command(namingLitPanel: nil))
    XCTAssertNil(requestSurfacePanel)
  }

  func testRequestPanelTreatsAPanelNamingNoUsableBoxAsNoPanel() throws {
    for panel in [
      #"{"displayId":0,"widthPt":669,"heightPt":951}"#,
      #"{"displayId":3,"widthPt":0,"heightPt":951}"#,
      #"{"displayId":3,"widthPt":669,"heightPt":-951}"#,
    ] {
      setRequestLitPanel(from: try command(namingLitPanel: panel))
      XCTAssertNil(requestSurfacePanel, panel)
    }
  }

  /// Decoded from JSON, so a renamed wire field fails here.
  private func command(namingLitPanel panel: String?) throws -> Command {
    let fields = ["\"command\":\"tap\"", panel.map { "\"litPanel\":\($0)" }].compactMap { $0 }
    return try JSONDecoder().decode(
      Command.self,
      from: Data("{\(fields.joined(separator: ","))}".utf8)
    )
  }
}
#endif
