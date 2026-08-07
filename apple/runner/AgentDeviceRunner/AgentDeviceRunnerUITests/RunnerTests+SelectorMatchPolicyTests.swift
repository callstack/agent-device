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
