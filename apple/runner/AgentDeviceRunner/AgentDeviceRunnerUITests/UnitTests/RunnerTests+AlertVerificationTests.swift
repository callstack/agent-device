import XCTest

extension RunnerTests {
#if AGENT_DEVICE_RUNNER_UNIT_TESTS
  func testAlertVerificationDoesNotConfuseASharedButtonWithTheOriginalPresentation() {
    let original = RunnerAlertPresentation(title: "First permission", content: ["First body"], buttons: ["Allow"])
    let replacement = RunnerAlertPresentation(title: "Next permission", content: ["Next body"], buttons: ["Allow"])
    XCTAssertEqual(
      RunnerAlertVerification.verify(original: original, observation: .visible(replacement)),
      .presentationChanged
    )
  }

  func testAlertVerificationComparesMoreThanTheTitle() {
    let original = RunnerAlertPresentation(title: "Confirmation", content: ["First body"], buttons: ["Cancel", "OK"])
    let changedBody = RunnerAlertPresentation(title: "Confirmation", content: ["Next body"], buttons: ["Cancel", "OK"])
    let changedButtons = RunnerAlertPresentation(title: "Confirmation", content: ["First body"], buttons: ["Not now", "OK"])
    for replacement in [changedBody, changedButtons] {
      XCTAssertEqual(
        RunnerAlertVerification.verify(original: original, observation: .visible(replacement)),
        .presentationChanged
      )
    }
  }

  func testAlertVerificationKeepsIdenticalOrTitlelessPresentationsUnconfirmed() {
    for title in ["Confirmation", ""] {
      let original = RunnerAlertPresentation(title: title, content: [], buttons: ["OK"])
      XCTAssertEqual(
        RunnerAlertVerification.verify(original: original, observation: .visible(original)),
        .stillVisible
      )
    }
  }

  func testAlertVerificationRequiresProvenAbsence() {
    let original = RunnerAlertPresentation(title: "Confirmation", content: [], buttons: ["OK"])
    XCTAssertEqual(
      RunnerAlertVerification.verify(original: original, observation: .absent),
      .disappeared
    )
    XCTAssertEqual(
      RunnerAlertVerification.verify(original: original, observation: .unavailable),
      .unconfirmed
    )
    XCTAssertEqual(
      RunnerAlertVerification.verify(original: original, observation: .deadlineExceeded),
      .timedOut
    )
  }
#endif
}
