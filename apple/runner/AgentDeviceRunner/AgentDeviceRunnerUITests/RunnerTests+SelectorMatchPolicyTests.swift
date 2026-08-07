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
#endif
}
