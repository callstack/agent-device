import XCTest

final class TextInputProbeIssues {
  let thread = Thread.current
  var count = 0
}

enum TextInputProbeFailure: String, Error {
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

  /// The input `coordinateTapTextInputAt` finds, with the identity it carried then, read inside the
  /// same issue containment. Nil when the probe finds none or cannot answer.
  func coordinateTapTextInputIdentityAt(app: XCUIApplication, x: Double, y: Double) -> TextInputAtPoint? {
    let probed = containingTextInputProbeIssues(fallback: nil) { shouldStop -> TextInputAtPoint? in
      guard let element = queryTextInputs(app: app, point: CGPoint(x: x, y: y), shouldStop: shouldStop).first,
            case .input(let identity) = probeTextEntryInput(element)
      else {
        return nil
      }
      return TextInputAtPoint(element: element, identity: identity)
    }
    guard case .success(let input) = probed else { return nil }
    return input
  }

  /// Whether `input`'s handle still resolves to the input it named when found, read inside the
  /// same issue containment. A read that cannot answer counts as no.
  func textInputStillResolves(_ input: TextInputAtPoint) -> Bool {
    let probed = containingTextInputProbeIssues(fallback: false) { _ in
      input.element.exists && probeTextEntryInput(input.element) == .input(input.identity)
    }
    guard case .success(let resolves) = probed else { return false }
    return resolves
  }

  /// What `target`'s input reads between a replacement's clear passes, read inside the same issue
  /// containment, with a placeholder read as empty. A read that cannot answer is `.unavailable`.
  func clearedFieldRead(app: XCUIApplication, target: TextEntryTarget) -> ClearedFieldRead {
    let probed = containingTextInputProbeIssues(fallback: ClearedFieldRead.unavailable) { _ in
      guard let input = resolveTextEntryElement(app: app, target: target) else { return .unavailable }
      if input.elementType == .secureTextField { return .unreadable }
      return editableTextValue(for: input, treatingPlaceholderAsEmpty: true).map { .text($0) } ?? .unavailable
    }
    guard case .success(let read) = probed else { return .unavailable }
    return read
  }

  func probeTextInputs(app: XCUIApplication, point: CGPoint) -> TextInputProbeOutcome {
    switch containingTextInputProbeIssues(fallback: [], { shouldStop in
      queryTextInputs(app: app, point: point, shouldStop: shouldStop)
    }) {
    case .success(let elements):
      return elements.isEmpty ? .absent : .matches(elements)
    case .failure(let failure):
      return .unavailable(failure)
    }
  }

  /// Runs an optional probe whose XCTest issues are contained instead of recorded: an issue makes
  /// the probe unavailable rather than failing the command and invalidating the runner.
  private func containingTextInputProbeIssues<T>(
    fallback: T,
    _ probe: (_ shouldStop: () -> Bool) -> T
  ) -> Result<T, TextInputProbeFailure> {
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
    let (value, exception) = catchingObjCException(fallback: fallback) {
      probe({ self.hasTextInputProbeIssues(issues) })
    }
    if hasTextInputProbeIssues(issues) { return .failure(.recordedIssue) }
    if exception != nil { return .failure(.exception) }
    return .success(value)
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
