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

  func testLitPanelSnapshotRefusesAPinToABackendThatCannotProveThePanel() throws {
    func refusal(_ fields: String) throws -> ErrorPayload? {
      try Self.litPanelBackendPinRefusal(runnerCommandFixture(#"{"command":"snapshot"\#(fields)}"#))?.error
    }
    XCTAssertEqual(try refusal(#","preferredBackend":"private-ax""#)?.code, "UNSUPPORTED_OPERATION")
    XCTAssertEqual(try refusal(#","preferredBackend":"queries""#)?.code, "UNSUPPORTED_OPERATION")
    XCTAssertNil(try refusal(#","preferredBackend":"tree""#))
    XCTAssertNil(try refusal(""))
    let implied = try XCTUnwrap(refusal(#","customActions":true"#))
    XCTAssertEqual(implied.code, "UNSUPPORTED_OPERATION")
    XCTAssertTrue(implied.message.contains("customActions"), implied.message)
    XCTAssertFalse(implied.hint?.contains("backend pin") ?? true, implied.hint ?? "")
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
  /// Launches the app and names its own window's display and box as the lit panel: the
  /// `litPanel` JSON member, and the window frame.
  @MainActor
  private func launchAppOnTheLitPanel() -> (panel: String, frame: CGRect) {
    app.launch()
    mainOwned.app = app
    let window = app.windows.firstMatch
    var displayID: UInt = 0
    XCTAssertNil(RunnerResolveWindowDisplayID(window, &displayID))
    let frame = window.frame
    return (#""litPanel":{"displayId":\#(displayID),"widthPt":\#(frame.width),"heightPt":\#(frame.height)}"#, frame)
  }

  @MainActor
  private func tearDownLitPanelApp() {
    litPanelWindowWalkIssueForTesting = false
    setRequestLitPanel(from: try! runnerCommandFixture(#"{"command":"tap"}"#))
    invalidateCachedTarget(reason: "unit_test_cleanup")
    app.terminate()
  }

  /// Runs `command` against the launched app while the request names display 999, which none of
  /// the app's windows is on.
  @MainActor
  private func responseWithTheAppOffTheLitPanel(
    _ json: String,
    _ run: (Command) throws -> Response
  ) throws -> Response {
    app.launch()
    mainOwned.app = app
    defer { tearDownLitPanelApp() }
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

  /// The app's window is booked on the lit panel, and then a window vanishes during the element
  /// search's walk: the issue is held, the read refuses with the typed code instead of finding
  /// nothing, and a coordinate `type` refuses before it taps a point with no target.
  @MainActor
  func testElementReadsRefuseWhenTheLitPanelWindowWalkFails() throws {
    let (panel, frame) = launchAppOnTheLitPanel()
    defer { tearDownLitPanelApp() }
    for json in [
      #"{"command":"readText","x":\#(frame.midX),"y":\#(frame.midY),\#(panel)}"#,
      #"{"command":"type","text":"x","x":\#(frame.midX),"y":\#(frame.midY),\#(panel)}"#,
    ] {
      let command = try runnerCommandFixture(json)
      setRequestLitPanel(from: command)
      XCTAssertNil(bookRequestLitPanelSurface(app: app), "the window is on the lit panel")
      litPanelWindowWalkIssueForTesting = true
      let response = try executeOnMainPrepared(command: command, activeApp: app)
      litPanelWindowWalkIssueForTesting = false
      XCTAssertEqual(response.error?.code, "APP_SCREEN_UNRESOLVED", json)
    }
  }

  /// A bound input re-read on a lit-panel request whose walk fails propagates the refusal, and the
  /// input cannot be proven gone.
  @MainActor
  func testBoundInputReReadRefusesWhenTheLitPanelWalkFails() throws {
    app.launchArguments = ["--agent-device-text-entry-regression"]
    let (panel, _) = launchAppOnTheLitPanel()
    defer {
      app.launchArguments = []
      tearDownLitPanelApp()
    }
    let identifier = "agent-device-hardware-keyboard-input"
    let field = app.textFields[identifier]
    XCTAssertTrue(field.waitForFixtureExistence(timeout: appExistenceTimeout))
    let frame = field.frame
    let target = TextEntryTarget(
      element: nil,
      refreshPoint: CGPoint(x: frame.midX, y: frame.midY),
      prefersFocusedElement: false,
      contentTranslation: .none,
      boundIdentity: TextEntryInputIdentity(elementType: .textField, identifier: identifier)
    )
    let command = try runnerCommandFixture(#"{"command":"type",\#(panel)}"#)
    setRequestLitPanel(from: command)
    XCTAssertNotNil(try resolveTextEntryInput(app: app, target: target), "the walk answers")
    setRequestLitPanel(from: command)
    litPanelWindowWalkIssueForTesting = true
    XCTAssertThrowsError(try resolveTextEntryInput(app: app, target: target)) {
      XCTAssertEqual($0 as? RunnerAppScreenCaptureFailure, .unresolvedScreen)
    }
    XCTAssertFalse(boundTextEntryInputIsGone(app: app, target: target))
  }

  /// The walk answers but finds no input at the refresh point, so resolution reaches the
  /// identifier query: on a lit-panel request it searches only the lit windows, so a field the
  /// app-wide query finds, standing in for the dark panel's twin, is not resolved.
  @MainActor
  func testBoundInputIdentifierQuerySearchesOnlyTheLitWindows() throws {
    app.launchArguments = ["--agent-device-text-entry-regression"]
    app.launch()
    mainOwned.app = app
    defer {
      app.launchArguments = []
      tearDownLitPanelApp()
    }
    let identifier = "agent-device-hardware-keyboard-input"
    let field = app.textFields[identifier]
    XCTAssertTrue(field.waitForFixtureExistence(timeout: appExistenceTimeout))
    let frame = field.frame
    let target = TextEntryTarget(
      element: nil,
      refreshPoint: CGPoint(x: frame.midX, y: frame.midY),
      prefersFocusedElement: false,
      contentTranslation: .none,
      boundIdentity: TextEntryInputIdentity(elementType: .textField, identifier: identifier)
    )
    setRequestLitPanel(from: try runnerCommandFixture(#"{"command":"type"}"#))
    XCTAssertNotNil(try resolveTextEntryInput(app: app, target: target), "the app-wide query finds it")
    setRequestLitPanel(from: try runnerCommandFixture(
      #"{"command":"type","litPanel":{"displayId":999,"widthPt":669,"heightPt":951}}"#
    ))
    guard case .absent = try probeTextInputs(app: app, point: CGPoint(x: frame.midX, y: frame.midY), contentTranslation: .none) else {
      return XCTFail("the walk answers with no input at the point")
    }
    XCTAssertNil(try resolveTextEntryInput(app: app, target: target))
  }

  /// With a lit panel named, selector and point reads search only the windows on that display; the
  /// launched app's windows are all on another one, so neither read may answer.
  @MainActor
  func testElementReadsSearchOnlyTheLitDisplaysWindows() throws {
    var found: (unnamed: Bool, named: Bool, text: String?, namedText: String?) = (false, false, nil, nil)
    _ = try responseWithTheAppOffTheLitPanel(
      #"{"command":"tap","x":1,"y":1,"litPanel":{"displayId":999,"widthPt":669,"heightPt":951}}"#
    ) { _ in
      found.named = try findElement(app: app, selectorKey: "label", selectorValue: "Agent Device Runner")
        .element != nil
      let unnamed = try runnerCommandFixture(#"{"command":"tap"}"#)
      setRequestLitPanel(from: unnamed)
      let match = try findElement(app: app, selectorKey: "label", selectorValue: "Agent Device Runner")
      found.unnamed = match.element != nil
      if let frame = match.element?.frame {
        found.text = try readTextAt(app: app, x: frame.midX, y: frame.midY)
        setRequestLitPanel(from: try runnerCommandFixture(
          #"{"command":"tap","litPanel":{"displayId":999,"widthPt":669,"heightPt":951}}"#
        ))
        found.namedText = try readTextAt(app: app, x: frame.midX, y: frame.midY)
      }
      return Response(ok: true)
    }
    XCTAssertTrue(found.unnamed, "the label exists in the app's own window")
    XCTAssertNotNil(found.text)
    XCTAssertFalse(found.named, "a selector read must not search off the lit display")
    XCTAssertNil(found.namedText, "a point read must not search off the lit display")
  }

  /// A refused pin is a request refusal: it never reaches the capture plan, so it does not
  /// invalidate the cached target the next command relies on.
  @MainActor
  func testLitPanelSnapshotPinRefusalKeepsTheCachedTarget() throws {
    let (panel, _) = launchAppOnTheLitPanel()
    mainOwned.bundleId = "com.callstack.agentdevice.runner"
    defer { tearDownLitPanelApp() }
    let command = try runnerCommandFixture(
      #"{"appBundleId":"com.callstack.agentdevice.runner","command":"snapshot","preferredBackend":"private-ax",\#(panel)}"#
    )
    setRequestLitPanel(from: command)
    let response = try executeSnapshotDispatched(command: command)
    XCTAssertEqual(response.error?.code, "UNSUPPORTED_OPERATION")
    XCTAssertTrue(mainOwned.app === app, "a refused pin must not invalidate the cached target")
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
