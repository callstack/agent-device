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
  case matches([RunnerTests.ResolvedTextEntryInput])
  case absent
  case unavailable(TextInputProbeFailure)
}

extension RunnerTests {
  func textInputAt(app: XCUIApplication, x: Double, y: Double) -> ResolvedTextEntryInput? {
    textInputCandidatesAt(app: app, point: CGPoint(x: x, y: y)).first
  }

  func textInputCandidatesAt(app: XCUIApplication, point: CGPoint) -> [ResolvedTextEntryInput] {
    safely("TEXT_INPUT_AT_POINT", []) {
      queryTextInputs(app: app, point: point, shouldStop: { false })
    }
  }

  func coordinateTapTextInputAt(app: XCUIApplication, x: Double, y: Double) -> XCUIElement? {
    switch probeTextInputs(app: app, point: CGPoint(x: x, y: y)) {
    case .matches(let inputs):
      return inputs.first?.element
    case .absent:
      return nil
    case .unavailable:
      return nil
    }
  }

  /// What the point's text-input lookup can say before a coordinate gesture is dispatched: the
  /// input it found, no input at the point, or nothing. A lookup that cannot answer is neither of the
  /// first two, and must not be read as one of them.
  enum CoordinateTextInputResolution {
    case input(TextInputAtPoint)
    case absent
    case unavailable
  }

  /// The input `coordinateTapTextInputAt` finds, with the identity it carried then, read inside the
  /// same issue containment, split into what the lookup can name so a refusal can tell an empty
  /// point from a blind one.
  func coordinateTapTextInputIdentityAt(
    app: XCUIApplication,
    x: Double,
    y: Double
  ) -> CoordinateTextInputResolution {
    let probed = containingTextInputProbeIssues(fallback: CoordinateTextInputResolution.unavailable) {
      shouldStop -> CoordinateTextInputResolution in
      guard let input = queryTextInputs(app: app, point: CGPoint(x: x, y: y), shouldStop: shouldStop).first else {
        return .absent
      }
      guard let identity = input.identity else {
        return .unavailable
      }
      return .input(TextInputAtPoint(element: input.element, identity: identity))
    }
    switch probed {
    case .success(let resolution):
      return resolution
    case .failure:
      return .unavailable
    }
  }

  /// `input`'s handle, read again, when it still resolves to the input it named when found, read
  /// inside the same issue containment. A read that cannot answer counts as no.
  func textInputIfStillResolves(_ input: TextInputAtPoint) -> ResolvedTextEntryInput? {
    let probed = containingTextInputProbeIssues(fallback: nil as ResolvedTextEntryInput?) { _ in
      ResolvedTextEntryInput(reading: input.element).flatMap { $0.identity == input.identity ? $0 : nil }
    }
    guard case .success(let read) = probed else { return nil }
    return read
  }

  /// What `target`'s input reads between a replacement's clear passes, read inside the same issue
  /// containment, with a placeholder read as empty. A read that cannot answer is `.unavailable`.
  func clearedFieldRead(app: XCUIApplication, target: TextEntryTarget) -> TextValueRead {
    let probed = containingTextInputProbeIssues(fallback: TextValueRead.unavailable) { _ in
      textValueRead(for: resolveTextEntryInput(app: app, target: target)?.attributes, treatingPlaceholderAsEmpty: true)
    }
    guard case .success(let read) = probed else { return .unavailable }
    return read
  }

  func probeTextInputs(app: XCUIApplication, point: CGPoint) -> TextInputProbeOutcome {
    switch containingTextInputProbeIssues(fallback: [], { shouldStop in
      queryTextInputs(app: app, point: point, shouldStop: shouldStop)
    }) {
    case .success(let inputs):
      return inputs.isEmpty ? .absent : .matches(inputs)
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
  ) -> [ResolvedTextEntryInput] {
    var inputs: [ResolvedTextEntryInput] = []
    for query in [app.textFields, app.secureTextFields, app.searchFields, app.textViews] {
      if shouldStop() { break }
      let candidates = query.allElementsBoundByIndex
#if AGENT_DEVICE_RUNNER_UNIT_TESTS
      if let issue = textInputProbeIssueForTesting {
        textInputProbeIssueForTesting = nil
        record(issue)
      }
#endif
      // One snapshot per candidate answers enablement, frame, and the ordering below. A candidate that
      // cannot be snapshotted is read live, so its failure still reaches the caller's issue handling.
      for element in candidates {
        if shouldStop() { break }
        guard let candidate = ResolvedTextEntryInput(readingListed: element) else { continue }
        let attributes = candidate.attributes
        if isCoordinateTextInputCandidate(enabled: attributes.isEnabled, frame: attributes.frame, point: point) {
          inputs.append(candidate)
        }
      }
    }
    guard !shouldStop() else { return [] }
    return inputs.sorted { smallestElementFirst($0.attributes, $1.attributes) }
  }
}
