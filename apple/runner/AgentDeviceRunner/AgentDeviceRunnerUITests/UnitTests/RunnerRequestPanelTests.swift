import XCTest

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
extension RunnerTests {
  /// One runner process can serve a foldable's `tap` and then a single-panel request; the second
  /// must not resolve against the first's panel.
  func testRequestPanelFollowsTheCommandAndAnUnnamedPanelClearsIt() throws {
    setRequestLitPanel(from: try command(namingLitPanel: #"{"displayId":3,"widthPt":669,"heightPt":951}"#))
    XCTAssertEqual(requestLitPanel?.displayID, 3)
    XCTAssertEqual(requestLitPanel?.widthPt, 669)
    XCTAssertEqual(requestLitPanel?.heightPt, 951)

    setRequestLitPanel(from: try command(namingLitPanel: nil))
    XCTAssertNil(requestLitPanel)
  }

  func testRequestPanelTreatsAPanelNamingNoUsableBoxAsNoPanel() throws {
    for panel in [
      #"{"displayId":0,"widthPt":669,"heightPt":951}"#,
      #"{"displayId":3,"widthPt":0,"heightPt":951}"#,
      #"{"displayId":3,"widthPt":669,"heightPt":-951}"#,
    ] {
      setRequestLitPanel(from: try command(namingLitPanel: panel))
      XCTAssertNil(requestLitPanel, panel)
    }
  }

  /// Main work a command abandoned runs before the next command's panel is written, so it still
  /// reads its own command's panel.
  func testRequestLitPanelIsWrittenBehindMainWorkAlreadyQueued() throws {
    let unnamed = try command(namingLitPanel: nil)
    let named = try command(namingLitPanel: #"{"displayId":3,"widthPt":669,"heightPt":951}"#)
    setRequestLitPanel(from: unnamed)
    let drained = expectation(description: "main queue drained")
    var queuedEarlier: UInt?
    var queuedLater: UInt?
    DispatchQueue.global().async {
      DispatchQueue.main.async { queuedEarlier = self.requestLitPanel?.displayID ?? 0 }
      self.setRequestLitPanel(from: named)
      DispatchQueue.main.async {
        queuedLater = self.requestLitPanel?.displayID ?? 0
        drained.fulfill()
      }
    }
    wait(for: [drained], timeout: 5)
    setRequestLitPanel(from: unnamed)
    XCTAssertEqual(queuedEarlier, 0)
    XCTAssertEqual(queuedLater, 3)
  }

  func testLitPanelSnapshotRefusesAPinToABackendThatCannotProveThePanel() {
    XCTAssertEqual(Self.litPanelBackendPinFailure("private-ax").code, "UNSUPPORTED_OPERATION")
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

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
extension RunnerTests {
  /// A window whose display the runtime does not name may be on the dark panel, so it is dropped.
  func testLitPanelSnapshotKeepsOnlyWindowsProvenOnTheLitDisplay() {
    let windows: [(name: String, displayID: UInt?)] = [("outer", 1), ("unknown", nil), ("inner", 3)]
    let kept = Self.windowsOnLitDisplay(windows, litDisplayID: 3) { $0.displayID }
    XCTAssertEqual(kept.map(\.name), ["inner"])
  }

#if os(iOS)
  /// Runs `command` against the launched app while the request names display 999, which none of
  /// the app's windows is on.
  @MainActor
  private func responseWithTheAppOffTheLitPanel(
    _ json: String,
    _ run: (Command) throws -> Response
  ) throws -> Response {
    app.launch()
    mainOwned.app = app
    defer {
      setRequestLitPanel(from: try! runnerCommandFixture(#"{"command":"tap"}"#))
      invalidateCachedTarget(reason: "unit_test_cleanup")
      app.terminate()
    }
    let command = try runnerCommandFixture(json)
    setRequestLitPanel(from: command)
    return try run(command)
  }

  @MainActor
  func testCoordinateTapRefusesBeforeDispatchWhenTheAppIsOffTheLitPanel() throws {
    var fellBack = true
    let response = try responseWithTheAppOffTheLitPanel(
      #"{"command":"tap","x":40,"y":120,"synthesized":true,"litPanel":{"displayId":999,"widthPt":669,"heightPt":951}}"#
    ) { command in
      let response = try executeOnMainPrepared(command: command, activeApp: app)
      fellBack = resolveRunnerWindowElement(app: app) != nil
      return response
    }
    XCTAssertEqual(response.error?.code, "APP_SCREEN_OFF_LIT_PANEL")
    XCTAssertFalse(fellBack, "no read in the request may fall back to the app")
  }

  /// With a lit panel named, selector and point reads search only the windows on that display; the
  /// launched app's windows are all on another one, so neither read may answer.
  @MainActor
  func testElementReadsSearchOnlyTheLitDisplaysWindows() throws {
    var found: (unnamed: Bool, named: Bool, text: String?, namedText: String?) = (false, false, nil, nil)
    _ = try responseWithTheAppOffTheLitPanel(
      #"{"command":"tap","x":1,"y":1,"litPanel":{"displayId":999,"widthPt":669,"heightPt":951}}"#
    ) { _ in
      found.named = findElement(app: app, selectorKey: "label", selectorValue: "Agent Device Runner")
        .element != nil
      let unnamed = try runnerCommandFixture(#"{"command":"tap"}"#)
      setRequestLitPanel(from: unnamed)
      let match = findElement(app: app, selectorKey: "label", selectorValue: "Agent Device Runner")
      found.unnamed = match.element != nil
      if let frame = match.element?.frame {
        found.text = readTextAt(app: app, x: frame.midX, y: frame.midY)
        setRequestLitPanel(from: try runnerCommandFixture(
          #"{"command":"tap","litPanel":{"displayId":999,"widthPt":669,"heightPt":951}}"#
        ))
        found.namedText = readTextAt(app: app, x: frame.midX, y: frame.midY)
      }
      return Response(ok: true)
    }
    XCTAssertTrue(found.unnamed, "the label exists in the app's own window")
    XCTAssertNotNil(found.text)
    XCTAssertFalse(found.named, "a selector read must not search off the lit display")
    XCTAssertNil(found.namedText, "a point read must not search off the lit display")
  }

  @MainActor
  func testSnapshotRefusesWhenTheAppIsOffTheLitPanel() throws {
    let response = try responseWithTheAppOffTheLitPanel(
      #"{"command":"snapshot","interactiveOnly":true,"litPanel":{"displayId":999,"widthPt":669,"heightPt":951}}"#
    ) { try executeSnapshotDispatched(command: $0) }
    XCTAssertEqual(response.error?.code, "APP_SCREEN_OFF_LIT_PANEL")
  }
#endif
}
#endif
