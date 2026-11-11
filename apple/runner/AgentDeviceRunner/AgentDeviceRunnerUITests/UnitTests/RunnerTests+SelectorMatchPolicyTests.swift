import XCTest
import AgentDeviceSnapshotPresentation

extension RunnerTests {
#if AGENT_DEVICE_RUNNER_UNIT_TESTS
  func testNativeReadPrefilterPreservesNormalizedExactIdentity() {
    for identifier in ["  continue-control\n", "", "caf\u{0065}\u{0301}"] {
      let label = identifier.isEmpty ? "  caf\u{0065}\u{0301}\n" : "Continue"
      let target = AuthorizedPressTarget(type: 9, identifier: identifier, label: label, value: nil,
        rect: SnapshotRect(x: 10, y: 20, width: 100, height: 40), point: PressTargetPoint(x: 60, y: 40))
      let rawIdentifier = identifier.trimmingCharacters(in: .whitespacesAndNewlines).precomposedStringWithCanonicalMapping
      let rawLabel = label.trimmingCharacters(in: .whitespacesAndNewlines).precomposedStringWithCanonicalMapping
      XCTAssertTrue(Self.authorizedPressTargetPredicate(target).evaluate(with: [
        "elementType": 9, "identifier": rawIdentifier, "label": rawLabel,
      ]))
      XCTAssertFalse(Self.authorizedPressTargetPredicate(target).evaluate(with: [
        "elementType": 9, "identifier": rawIdentifier, "label": "Unrelated",
      ]))
      XCTAssertTrue(target.matches(type: 9, identifier: rawIdentifier, label: rawLabel, value: nil, rect: target.rect))
      XCTAssertFalse(target.matches(type: 9, identifier: rawIdentifier + "-other", label: rawLabel, value: nil, rect: target.rect))
    }
  }

  func testAuthorizedPressTargetMatchesGoldenParityTable() throws {
    struct Fixture: Decodable {
      let name: String
      let expected: NativePressTarget
      let candidate: NativePressTarget
      let matches: Bool
    }
    let root = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    let fixtures = try JSONDecoder().decode([Fixture].self, from:
      Data(contentsOf: root.appendingPathComponent("contracts/fixtures/authorized-press-target.json")))
      .map { fixture in
        (name: fixture.name, expected: AuthorizedPressTarget(type: fixture.expected.type,
          identifier: fixture.expected.identifier, label: fixture.expected.label, value: fixture.expected.value,
          rect: fixture.expected.rect, point: PressTargetPoint(x: 0, y: 0)), candidate: fixture.candidate,
          matches: fixture.matches)
      }
    XCTAssertFalse(fixtures.isEmpty)
    for fixture in fixtures {
      let candidate = fixture.candidate
      XCTAssertEqual(fixture.expected.matches(type: candidate.type, identifier: candidate.identifier,
        label: candidate.label, value: candidate.value, rect: candidate.rect), fixture.matches, fixture.name)
    }
    // JSON cannot encode non-finite numbers; both consumers exercise them natively.
    let reference = fixtures[0].expected
    let r = reference.rect
    for invalid in [Double.nan, Double.infinity, -Double.infinity] {
      for rect in [
        SnapshotRect(x: invalid, y: r.y, width: r.width, height: r.height),
        SnapshotRect(x: r.x, y: invalid, width: r.width, height: r.height),
        SnapshotRect(x: r.x, y: r.y, width: invalid, height: r.height),
        SnapshotRect(x: r.x, y: r.y, width: r.width, height: invalid),
      ] {
        XCTAssertFalse(reference.matches(type: reference.type, identifier: reference.identifier,
          label: reference.label, value: reference.value, rect: rect))
        let invalidTarget = AuthorizedPressTarget(type: reference.type, identifier: reference.identifier,
          label: reference.label, value: reference.value, rect: rect, point: reference.point)
        XCTAssertFalse(invalidTarget.matches(type: reference.type, identifier: reference.identifier,
          label: reference.label, value: reference.value, rect: rect))
      }
    }
  }

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
  @MainActor
  func testQuerySelectorPrefersHittableMatchOverNonHittableDuplicate() throws {
    let duplicateIdentifier = "agent-device-selector-read-duplicate"
    app.launchArguments = ["--agent-device-selector-read-regression"]
    app.launch()
    defer {
      invalidateCachedTarget(reason: "unit_test_cleanup")
      app.terminate()
    }
    XCTAssertTrue(app.waitForFixtureExistence(timeout: appExistenceTimeout))

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

    // The same native owner must not use the read preference for a previously resolved target.
    for element in matches {
      let frame = element.frame
      // Canonical presentation coordinates must not filter the source-native identity/frame.
      for point in [PressTargetPoint(x: frame.midX, y: frame.midY), PressTargetPoint(x: -10_000, y: -10_000)] {
        let target = AuthorizedPressTarget(type: element.elementType.rawValue,
          identifier: element.identifier, label: element.label, value: String(describing: element.value ?? ""),
          rect: SnapshotRect(frame), point: point)
        let readiness = try queryAuthorizedPressTarget(app: app, target: target)
        XCTAssertEqual(readiness.data?.pressReadiness, element.isHittable ? "ready" : "blocked")
      }
      let changedValue = AuthorizedPressTarget(type: element.elementType.rawValue,
        identifier: element.identifier, label: element.label, value: "not-the-native-value",
        rect: SnapshotRect(frame), point: PressTargetPoint(x: frame.midX, y: frame.midY))
      XCTAssertEqual(try queryAuthorizedPressTarget(app: app, target: changedValue).data?.pressReadiness, "missing")
    }
  }
#endif
#endif
}
