import XCTest

final class TextInputProbeIssues {
  let thread = Thread.current
  var count = 0
}

enum TextInputProbeFailure: String {
  case recordedIssue = "text_input_probe_recorded_issue"
  case exception = "text_input_probe_exception"
}

enum TextInputProbeOutcome {
  case matches([XCUIElement])
  case absent
  case unavailable(TextInputProbeFailure)
}

extension RunnerTests {
  func textInputAt(app: XCUIApplication, x: Double, y: Double) -> XCUIElement? {
    textInputCandidatesAt(app: app, point: CGPoint(x: x, y: y)).first
  }

  func textInputCandidatesAt(app: XCUIApplication, point: CGPoint) -> [XCUIElement] {
    safely("TEXT_INPUT_AT_POINT", []) {
      queryTextInputs(app: app, point: point, shouldStop: { false })
    }
  }

  func coordinateTapTextInputAt(app: XCUIApplication, x: Double, y: Double) -> XCUIElement? {
    switch probeTextInputs(app: app, point: CGPoint(x: x, y: y)) {
    case .matches(let elements):
      return elements.first
    case .absent:
      return nil
    case .unavailable:
      return nil
    }
  }

  func probeTextInputs(app: XCUIApplication, point: CGPoint) -> TextInputProbeOutcome {
    precondition(Thread.isMainThread)
    let issues = TextInputProbeIssues()
    suppressedIssueLock.lock()
    let previous = textInputProbeIssues
    textInputProbeIssues = issues
    suppressedIssueLock.unlock()
    defer {
      suppressedIssueLock.lock()
      textInputProbeIssues = previous
      suppressedIssueLock.unlock()
    }
    let (elements, exception) = catchingObjCException(fallback: []) {
      queryTextInputs(app: app, point: point, shouldStop: { self.hasTextInputProbeIssues(issues) })
    }
    if hasTextInputProbeIssues(issues) { return .unavailable(.recordedIssue) }
    if exception != nil { return .unavailable(.exception) }
    return elements.isEmpty ? .absent : .matches(elements)
  }

  private func hasTextInputProbeIssues(_ scope: TextInputProbeIssues) -> Bool {
    suppressedIssueLock.lock()
    defer { suppressedIssueLock.unlock() }
    return scope.count > 0
  }

  func containTextInputProbeIssue(_ issue: XCTIssue) -> Bool {
    suppressedIssueLock.lock()
    guard let scope = textInputProbeIssues, scope.thread === Thread.current else {
      suppressedIssueLock.unlock()
      return false
    }
    scope.count += 1
    suppressedIssueLock.unlock()
    NSLog("AGENT_DEVICE_RUNNER_TEXT_INPUT_PROBE_UNAVAILABLE issue=%@", issue.compactDescription)
    return true
  }

  private func queryTextInputs(
    app: XCUIApplication,
    point: CGPoint,
    shouldStop: () -> Bool
  ) -> [XCUIElement] {
    var candidates: [XCUIElement] = []
    for query in [app.textFields, app.secureTextFields, app.searchFields, app.textViews] {
      if shouldStop() { break }
      candidates.append(contentsOf: query.allElementsBoundByIndex)
#if AGENT_DEVICE_RUNNER_UNIT_TESTS
      if let issue = textInputProbeIssueForTesting {
        textInputProbeIssueForTesting = nil
        record(issue)
      }
#endif
    }
    guard !shouldStop() else { return [] }
    return candidates.filter { element in
      guard !shouldStop(), element.exists else { return false }
      return isCoordinateTextInputCandidate(enabled: element.isEnabled, frame: element.frame, point: point)
    }.sorted(by: smallestElementFirst)
  }
}
