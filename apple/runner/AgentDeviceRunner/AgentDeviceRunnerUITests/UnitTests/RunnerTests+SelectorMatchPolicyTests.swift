import XCTest

extension RunnerTests {
#if AGENT_DEVICE_RUNNER_UNIT_TESTS
  func testDirectSelectorRejectsTwoRawMatchesBeforeHittabilityPreference() {
    let decision = classifyDirectSelectorCandidates(
      [
        SelectorCandidateFacts(isHittable: true, hasTappableFrame: true),
        SelectorCandidateFacts(isHittable: false, hasTappableFrame: true),
      ],
      allowNonHittableFallback: false
    )

    XCTAssertEqual(decision, .ambiguous)
  }

  func testDirectSelectorAcceptsOneRawHittableMatch() {
    XCTAssertEqual(
      classifyDirectSelectorCandidates(
        [SelectorCandidateFacts(isHittable: true, hasTappableFrame: true)],
        allowNonHittableFallback: false
      ),
      .selected(index: 0, usedNonHittableFallback: false)
    )
  }

  // The read rows below are the regression guard for scoping the fail-closed
  // rule to mutations: querySelector backs get/is/wait, so the exact shape
  // that must stay resolvable is one hittable match beside a non-hittable
  // same-selector duplicate.
  func testReadSelectorPrefersTheHittableMatchOverANonHittableDuplicate() {
    let decision = classifyDirectSelectorCandidates(
      [
        SelectorCandidateFacts(isHittable: true, hasTappableFrame: true),
        SelectorCandidateFacts(isHittable: false, hasTappableFrame: true),
      ],
      allowNonHittableFallback: false,
      rawMatchPolicy: .preferHittableMatch
    )

    XCTAssertEqual(decision, .selected(index: 0, usedNonHittableFallback: false))
  }

  func testReadSelectorStillRejectsTwoHittableMatches() {
    XCTAssertEqual(
      classifyDirectSelectorCandidates(
        [
          SelectorCandidateFacts(isHittable: true, hasTappableFrame: true),
          SelectorCandidateFacts(isHittable: true, hasTappableFrame: true),
        ],
        allowNonHittableFallback: false,
        rawMatchPolicy: .preferHittableMatch
      ),
      .ambiguous
    )
  }

  // A read never coordinate-taps, so a non-hittable-only match stays a miss
  // rather than borrowing the Maestro fallback.
  func testReadSelectorDoesNotAdoptTheNonHittableCoordinateFallback() {
    XCTAssertEqual(
      classifyDirectSelectorCandidates(
        [SelectorCandidateFacts(isHittable: false, hasTappableFrame: true)],
        allowNonHittableFallback: false,
        rawMatchPolicy: .preferHittableMatch
      ),
      .noMatch
    )
  }

  func testMaestroSelectorKeepsExpectedPointAndNonHittableFallbackSemantics() {
    XCTAssertEqual(
      classifyDirectSelectorCandidates(
        [
          SelectorCandidateFacts(isHittable: false, hasTappableFrame: true, containsExpectedPoint: false),
          SelectorCandidateFacts(isHittable: false, hasTappableFrame: true, containsExpectedPoint: true),
        ],
        allowNonHittableFallback: true,
        filtersByExpectedPoint: true
      ),
      .selected(index: 1, usedNonHittableFallback: true)
    )
  }

#if os(iOS)
  func testQuerySelectorPrefersHittableMatchOverNonHittableDuplicate() throws {
    let duplicateIdentifier = "agent-device-selector-read-duplicate"
    app.launchArguments = ["--agent-device-selector-read-regression"]
    app.launch()
    defer {
      invalidateCachedTarget(reason: "unit_test_cleanup")
      app.terminate()
    }
    XCTAssertTrue(app.waitForExistence(timeout: appExistenceTimeout))

    let matches = app.descendants(matching: .any)
      .matching(identifier: duplicateIdentifier)
      .allElementsBoundByIndex
      .filter(\.exists)
    XCTAssertEqual(matches.count, 2, "fixture must expose two raw identifier matches")
    XCTAssertEqual(matches.filter(\.isHittable).count, 1, "fixture must expose exactly one hittable match")

    let command = try JSONDecoder().decode(
      Command.self,
      from: Data(
        #"{"command":"querySelector","commandId":"query-selector-duplicate","selectorKey":"id","selectorValue":"agent-device-selector-read-duplicate"}"#.utf8
      )
    )
    let response = try executeOnMainPrepared(command: command, activeApp: app)

    guard response.ok else {
      XCTFail(String(describing: response.error))
      return
    }
    XCTAssertEqual(response.data?.found, true)
    XCTAssertEqual(response.data?.nodes?.count, 1)
    XCTAssertEqual(response.data?.nodes?.first?.identifier, duplicateIdentifier)
    XCTAssertEqual(response.data?.nodes?.first?.hittable, true)
  }
#endif
#endif
}
