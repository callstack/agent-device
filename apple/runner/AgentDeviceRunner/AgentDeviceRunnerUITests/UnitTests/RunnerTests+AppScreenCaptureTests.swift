import XCTest

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
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

  func testScreenshotResultEncodesDisplayFactsUnderTheKeyTheHostReads() throws {
    // The measured open-Duo inner panel: 2852x2006 at scale 3 on display 3. The host reads these to
    // rescale an image it did not measure, so the key and the shape are a cross-language contract.
    let payload = DataPayload(
      message: "tmp/screenshot-1.png",
      screenshotMetadata: ScreenshotMetadataPayload(
        displayID: 3,
        pixelWidth: 2852,
        pixelHeight: 2006,
        pixelsPerPoint: 3
      )
    )
    let encoded = try JSONSerialization.jsonObject(
      with: JSONEncoder().encode(payload)
    ) as? [String: Any]
    XCTAssertEqual(encoded?["message"] as? String, "tmp/screenshot-1.png")
    let metadata = encoded?["screenshotMetadata"] as? [String: Any]
    XCTAssertEqual(metadata?["displayID"] as? UInt, 3)
    XCTAssertEqual(metadata?["pixelWidth"] as? Int, 2852)
    XCTAssertEqual(metadata?["pixelHeight"] as? Int, 2006)
    XCTAssertEqual(metadata?["pixelsPerPoint"] as? Double, 3)
  }

  func testScreenshotResultCarriesNoDisplayFactsWhenNothingResolved() throws {
    let encoded = try JSONSerialization.jsonObject(
      with: JSONEncoder().encode(DataPayload(message: "tmp/screenshot-1.png"))
    ) as? [String: Any]
    XCTAssertNil(encoded?["screenshotMetadata"])
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
