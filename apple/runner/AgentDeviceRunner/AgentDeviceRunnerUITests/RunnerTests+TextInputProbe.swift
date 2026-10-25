import XCTest
import AgentDeviceSnapshotPresentation

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
  func textInputAt(
    app: XCUIApplication,
    x: Double,
    y: Double,
    contentTranslation: TextEntryContentTranslation
  ) -> ResolvedTextEntryInput? {
    let point = CGPoint(x: x, y: y)
    return textInputCandidatesAt(app: app, point: point, contentTranslation: contentTranslation).first
  }

  func textInputCandidatesAt(
    app: XCUIApplication,
    point: CGPoint,
    contentTranslation: TextEntryContentTranslation
  ) -> [ResolvedTextEntryInput] {
    safely("TEXT_INPUT_AT_POINT", []) {
      queryTextInputs(app: app, point: point, contentTranslation: contentTranslation, shouldStop: { false })
    }
  }

  func coordinateTapTextInputAt(
    app: XCUIApplication,
    x: Double,
    y: Double,
    contentTranslation: TextEntryContentTranslation
  ) -> XCUIElement? {
    switch probeTextInputs(app: app, point: CGPoint(x: x, y: y), contentTranslation: contentTranslation) {
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
    y: Double,
    contentTranslation: TextEntryContentTranslation
  ) -> CoordinateTextInputResolution {
    let probed = containingTextInputProbeIssues(fallback: CoordinateTextInputResolution.unavailable) {
      shouldStop -> CoordinateTextInputResolution in
      guard let input = queryTextInputs(
        app: app,
        point: CGPoint(x: x, y: y),
        contentTranslation: contentTranslation,
        shouldStop: shouldStop
      ).first else {
        return .absent
      }
      guard let identity = input.identity else {
        return .unavailable
      }
      return .input(TextInputAtPoint(
        element: input.element,
        identity: identity,
        contentTranslation: contentTranslation
      ))
    }
    switch probed {
    case .success(let resolution):
      return resolution
    case .failure:
      return .unavailable
    }
  }

  /// `input`'s handle, read again, when it still resolves to the input it named when found, read
  /// inside the same issue containment, carrying the vector the finding command read. A read that
  /// cannot answer counts as no.
  func textInputIfStillResolves(
    _ input: TextInputAtPoint
  ) -> ResolvedTextEntryInput? {
    let probed = containingTextInputProbeIssues(fallback: nil as ResolvedTextEntryInput?) { _ in
      ResolvedTextEntryInput(reading: input.element, contentTranslation: input.contentTranslation)
        .flatMap { $0.identity == input.identity ? $0 : nil }
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

  func probeTextInputs(
    app: XCUIApplication,
    point: CGPoint,
    contentTranslation: TextEntryContentTranslation
  ) -> TextInputProbeOutcome {
    switch containingTextInputProbeIssues(fallback: [], { shouldStop in
      queryTextInputs(app: app, point: point, contentTranslation: contentTranslation, shouldStop: shouldStop)
    }) {
    case .success(let inputs):
      return inputs.isEmpty ? .absent : .matches(inputs)
    case .failure(let failure):
      return .unavailable(failure)
    }
  }

  /// Runs an optional probe whose XCTest issues are contained instead of recorded: an issue makes
  /// the probe unavailable rather than failing the command and invalidating the runner.
  func containingTextInputProbeIssues<T>(
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
    contentTranslation: TextEntryContentTranslation,
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
        guard let candidate = ResolvedTextEntryInput(
          readingListed: element,
          contentTranslation: contentTranslation
        ) else { continue }
        if isCoordinateTextInputCandidate(
          enabled: candidate.attributes.isEnabled,
          // A candidate with no snapshot is matched on its live frame, which is already screen space
          // and whose failure reaches the caller's issue handling. `frameOnScreen` is nil only when
          // the command's window read could not answer, so the live frame is the only box left.
          frame: candidate.frameOnScreen ?? candidate.element.frame,
          point: point
        ) {
          inputs.append(candidate)
        }
      }
    }
    guard !shouldStop() else { return [] }
    return inputs.sorted { smallestElementFirst($0.attributes, $1.attributes) }
  }

  /// The vector state that carries this session's snapshot-read app-content frames to their place on
  /// the screen (#3899). Each command that dispatches points from snapshot frames reads it once, at
  /// its own start, and hands it down; a read inside a typing loop never calls this, because the two
  /// live box reads below cost about 90 ms each on a heavy React Native screen.
  ///
  /// The signature and the vector are the capture's rule (`SnapshotContentTranslation`, ADR 0004)
  /// read from the two live boxes that name it: the application's `frame` is a `(0,0)`-anchored copy
  /// of the box the resolved window reports at its place on the screen. Any other pair of boxes
  /// declares no vector, so full-screen, iPhone, and each foldable panel keep frames as read.
  ///
  /// A read that cannot answer returns `.unknown`, never `.none`: on a placed window, a failed read
  /// that looked like full screen would dispatch raw window-local points as screen points — the
  /// #3899 failure — so consumers refuse `.unknown` instead of guessing through it.
  func liveContentTranslation(app: XCUIApplication) -> TextEntryContentTranslation {
    // The window read is contained like the probe lookups it replaces: a transient window that
    // records an XCTest issue costs the vector, not the runner session.
    let read = containingTextInputProbeIssues(fallback: nil as TextEntryContentTranslation?) { _ in
      guard let resolved = resolveRunnerWindowElement(app: app) else { return nil }
      guard let translation = SnapshotContentTranslation.offset(reportedBox: app.frame, viewportBox: resolved.frame) else {
        // Explicit type: `.none` alone means `Optional.none` to the compiler here.
        return TextEntryContentTranslation.none
      }
      return .known(translation)
    }
    switch read {
    case .success(let state):
      guard let state else { return .unknown }
      return state
    case .failure:
      return .unknown
    }
  }
}
