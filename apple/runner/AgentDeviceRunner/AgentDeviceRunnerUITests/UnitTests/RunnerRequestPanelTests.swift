import XCTest

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
// MARK: - The request-scoped lit panel (#2728, ADR 0025)

extension RunnerTests {
  /// The panel a command names is the panel that command's resolvers see, and a request that names
  /// none clears whatever the previous command left behind. One runner process can serve a foldable's
  /// `tap` and then a single-panel device's, and the second must not resolve against the first's panel.
  func testRequestPanelFollowsTheCommandAndAnUnnamedPanelClearsIt() throws {
    setRequestLitPanel(from: try command(namingLitPanel: #"{"displayId":3,"widthPt":669,"heightPt":951}"#))
    XCTAssertEqual(requestSurfacePanel.displayID, 3)
    XCTAssertEqual(requestSurfacePanel.widthPt, 669)
    XCTAssertEqual(requestSurfacePanel.heightPt, 951)

    setRequestLitPanel(from: try command(namingLitPanel: nil))
    XCTAssertEqual(
      requestSurfacePanel.displayID,
      0,
      "a request that names no panel must not inherit the previous command's"
    )
  }

  /// A panel that cannot describe a box cannot be compared with a window, so it answers as no panel
  /// and the resolver keeps the historic route rather than refusing every window it reads. The rows
  /// are the ways a panel table can report a panel without naming one: no display, or a display whose
  /// box has no size.
  func testRequestPanelTreatsAPanelNamingNoUsableBoxAsNoPanel() throws {
    for panel in [
      #"{"displayId":0,"widthPt":669,"heightPt":951}"#,
      #"{"displayId":3,"widthPt":0,"heightPt":951}"#,
      #"{"displayId":3,"widthPt":669,"heightPt":0}"#,
      #"{"displayId":3,"widthPt":-1,"heightPt":-951}"#,
    ] {
      setRequestLitPanel(from: try command(namingLitPanel: nil))
      setRequestLitPanel(from: try command(namingLitPanel: panel))
      XCTAssertEqual(
        requestSurfacePanel.displayID,
        0,
        "display 0 is what every resolver reads as the historic first-window route (\(panel))"
      )
    }
  }

  /// Built from JSON, because the slot's input is the wire shape the host sends; a Swift literal would
  /// keep compiling if the field were renamed.
  private func command(namingLitPanel panel: String?) throws -> Command {
    let fields = ["\"command\":\"tap\"", panel.map { "\"litPanel\":\($0)" }].compactMap { $0 }
    return try JSONDecoder().decode(
      Command.self,
      from: Data("{\(fields.joined(separator: ","))}".utf8)
    )
  }
}
#endif
