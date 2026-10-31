import XCTest

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
/// One read of contracts/fixtures/screen-capture-metadata.json. The capture decodes through the
/// production `ScreenshotMetadataPayload`, so the table cannot describe a shape this encoder does
/// not write, and this file's re-encode cannot write a shape the table does not describe. The table
/// names no field of its own: this struct and the host's reader in
/// `packages/contracts/src/screen-capture-contract.ts` are the only declarations of the shape, and
/// `packages/contracts/src/screen-capture-contract.test.ts` is the vitest twin (#2728).
private struct ScreenCaptureMetadataTable: Decodable {
  struct Capture: Decodable {
    let name: String
    let metadata: ScreenshotMetadataPayload
  }

  let key: String
  let captures: [Capture]
}

private func loadScreenCaptureMetadataTable() throws -> ScreenCaptureMetadataTable {
  let fixtureURL = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent() // UnitTests
    .deletingLastPathComponent() // AgentDeviceRunnerUITests
    .deletingLastPathComponent() // AgentDeviceRunner
    .deletingLastPathComponent() // runner
    .deletingLastPathComponent() // apple
    .deletingLastPathComponent() // repo root
    .appendingPathComponent("contracts/fixtures/screen-capture-metadata.json")
  return try JSONDecoder().decode(
    ScreenCaptureMetadataTable.self,
    from: Data(contentsOf: fixtureURL)
  )
}

extension RunnerTests {
  func testScreenCaptureFailureCarriesTheBridgeReasonAsItsOwnCode() {
    XCTAssertEqual(
      RunnerAppScreenCaptureFailure(.unresolvedWindow).rawValue,
      "APP_SCREEN_WINDOW_UNRESOLVED"
    )
    XCTAssertEqual(
      RunnerAppScreenCaptureFailure(.unresolvedScreen).rawValue,
      "APP_SCREEN_UNRESOLVED"
    )
    // The display resolved and the image did not: a distinct code, because an operator chasing a
    // panel problem is chasing the wrong thing here. This one has no bridge counterpart, so it is
    // named on the Swift reason rather than mapped from one.
    XCTAssertEqual(
      RunnerAppScreenCaptureFailure.unrenderableImage.rawValue,
      "APP_SCREEN_CAPTURE_UNRENDERABLE"
    )
    // A success-shaped reason cannot become a success: the only way here is a caller that forgot to
    // branch, and the capture it describes did not happen.
    XCTAssertEqual(
      RunnerAppScreenCaptureFailure(RunnerApplicationScreenFailure.none).rawValue,
      "APP_SCREEN_UNRESOLVED"
    )
  }

  func testScreenshotDisplayFactsReEncodeEveryGoldenTableRowUnderTheTablesKey() throws {
    let table = try loadScreenCaptureMetadataTable()
    XCTAssertFalse(table.captures.isEmpty, "the table must record at least one measured capture")
    for capture in table.captures {
      let payload = DataPayload(
        message: "tmp/screenshot-1.png",
        screenshotMetadata: capture.metadata
      )
      let encoded = try JSONSerialization.jsonObject(
        with: JSONEncoder().encode(payload)
      ) as? [String: Any]
      XCTAssertEqual(encoded?["message"] as? String, "tmp/screenshot-1.png", capture.name)
      // The host reads these facts under the key the table spells, which neither language restates.
      guard let metadata = encoded?[table.key] as? [String: Any] else {
        return XCTFail("\(capture.name): no display facts under the table's key '\(table.key)'")
      }
      XCTAssertEqual(metadata["displayID"] as? UInt, capture.metadata.displayID, capture.name)
      XCTAssertEqual(metadata["pixelWidth"] as? Int, capture.metadata.pixelWidth, capture.name)
      XCTAssertEqual(metadata["pixelHeight"] as? Int, capture.metadata.pixelHeight, capture.name)
      XCTAssertEqual(
        metadata["pixelsPerPoint"] as? Double,
        capture.metadata.pixelsPerPoint,
        capture.name
      )
    }
  }

  func testScreenshotResultCarriesNoDisplayFactsWhenNothingResolved() throws {
    let key = try loadScreenCaptureMetadataTable().key
    let encoded = try JSONSerialization.jsonObject(
      with: JSONEncoder().encode(DataPayload(message: "tmp/screenshot-1.png"))
    ) as? [String: Any]
    XCTAssertNil(encoded?[key], "a capture that resolved nothing owes no facts either")
  }
}
#endif

#if AGENT_DEVICE_RUNNER_UNIT_TESTS && os(iOS)
  extension RunnerTests {
    /// The no-session-app and not-running-app cases both reach the resolver as an unresolved window,
    /// and the capture is still owed a display: the home screen owns one (#2728).
    func testObservedScreenCaptureAsksTheSystemSurfaceWhenTheSessionWindowIsUnresolved() {
      var askedSystemSurface = false
      let outcome = selectObservedScreenCapture(
        resolving: { .failure(.unresolvedWindow) },
        fallingBack: {
          askedSystemSurface = true
          return .failure(.unrenderableImage)
        }
      )
      XCTAssertTrue(askedSystemSurface, "an unresolved window has to move the question on")
      guard case .failure(let systemAnswer) = outcome else {
        return XCTFail("the system surface refused, so a refusal is what the caller must get")
      }
      XCTAssertEqual(
        systemAnswer.rawValue,
        "APP_SCREEN_CAPTURE_UNRENDERABLE",
        "the system surface's answer is the answer, not the session app's"
      )
    }

    /// A window that resolved and then refused to name its display is the failure the host has to
    /// see; asking a second process would replace a real refusal with an unrelated capture.
    func testObservedScreenCaptureReportsADisplayRefusalWithoutAskingTheSystemSurface() {
      var askedSystemSurface = false
      let outcome = selectObservedScreenCapture(
        resolving: { .failure(.unresolvedScreen) },
        fallingBack: {
          askedSystemSurface = true
          return .failure(.unrenderableImage)
        }
      )
      XCTAssertFalse(askedSystemSurface, "only an unresolved window may reach the system surface")
      guard case .failure(let refusal) = outcome else {
        return XCTFail("a display that refused must not become a capture")
      }
      XCTAssertEqual(refusal.rawValue, "APP_SCREEN_UNRESOLVED")
    }

    func testObservedScreenCaptureKeepsTheSessionAppCaptureItResolved() {
      var askedSystemSurface = false
      let captured = CapturedAppScreen(
        image: UIImage(),
        displayID: 3,
        pixelWidth: 2852,
        pixelHeight: 2006,
        pixelsPerPoint: 3
      )
      let outcome = selectObservedScreenCapture(
        resolving: { .success(captured) },
        fallingBack: {
          askedSystemSurface = true
          return .failure(.unresolvedWindow)
        }
      )
      XCTAssertFalse(askedSystemSurface, "a resolved app is never second-guessed")
      XCTAssertEqual(try? outcome.get().displayID, 3)
    }
  }
#endif
