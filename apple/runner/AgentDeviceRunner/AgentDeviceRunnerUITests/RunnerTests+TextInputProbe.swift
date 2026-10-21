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
  /// The smallest text input at the point, with the snapshot its lookup read.
  func textInputAt(app: XCUIApplication, x: Double, y: Double) -> ResolvedTextEntryInput? {
    safely("TEXT_INPUT_AT_POINT", []) {
      queryTextInputs(app: app, point: CGPoint(x: x, y: y), shouldStop: { false })
    }.first
  }

  func textInputCandidatesAt(app: XCUIApplication, point: CGPoint) -> [XCUIElement] {
    safely("TEXT_INPUT_AT_POINT", []) {
      queryTextInputs(app: app, point: point, shouldStop: { false }).map(\.element)
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
      guard let element = queryTextInputs(app: app, point: CGPoint(x: x, y: y), shouldStop: shouldStop).first?.element
      else {
        return .absent
      }
      switch probeTextEntryInput(element) {
      case .input(let identity):
        return .input(TextInputAtPoint(element: element, identity: identity))
      case .noMatch:
        return .absent
      case .unavailable:
        return .unavailable
      }
    }
    switch probed {
    case .success(let resolution):
      return resolution
    case .failure:
      return .unavailable
    }
  }

  /// The snapshot of `input`'s handle when it still resolves to the input it named when found, read
  /// inside the same issue containment. A read that cannot answer counts as no.
  func textInputSnapshotIfStillResolves(_ input: TextInputAtPoint) -> XCUIElementSnapshot? {
    let probed = containingTextInputProbeIssues(fallback: nil as XCUIElementSnapshot?) { _ in
      guard input.element.exists else { return nil }
      let read = snapshotTextEntryInput(input.element)
      return read.probe == .input(input.identity) ? read.snapshot : nil
    }
    guard case .success(let snapshot) = probed else { return nil }
    return snapshot
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
      queryTextInputs(app: app, point: point, shouldStop: shouldStop).map(\.element)
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

  private static let textInputElementTypeRawValues: [UInt] = [
    XCUIElement.ElementType.textField,
    .secureTextField,
    .searchField,
    .textView,
  ].map(\.rawValue)

  private func queryTextInputs(
    app: XCUIApplication,
    point: CGPoint,
    shouldStop: () -> Bool
  ) -> [ResolvedTextEntryInput] {
    // One query for every text input type: each query snapshots the whole application.
    let candidates = app.descendants(matching: .any)
      .matching(NSPredicate(format: "elementType IN %@", Self.textInputElementTypeRawValues))
      .allElementsBoundByIndex
#if AGENT_DEVICE_RUNNER_UNIT_TESTS
    if let issue = textInputProbeIssueForTesting {
      textInputProbeIssueForTesting = nil
      record(issue)
    }
#endif
    guard !shouldStop() else { return [] }
    // One snapshot per candidate answers enablement, frame, and the ordering below: each attribute
    // read from the live element runs the candidate's query again. A candidate that cannot be
    // snapshotted is read live, so its failure still reaches the caller's issue handling.
    // Each handle binds by index within its own element type, so an input of another type that
    // appears ahead of it later does not take its place.
    var indexByType: [XCUIElement.ElementType: Int] = [:]
    var inputs: [ResolvedTextEntryInput] = []
    for (position, element) in candidates.enumerated() {
      if shouldStop() { break }
      guard element.exists else { continue }
      let snapshot = try? element.snapshot()
      let elementType = snapshot?.elementType ?? element.elementType
      let typeIndex = indexByType[elementType, default: 0]
      indexByType[elementType] = typeIndex + 1
#if AGENT_DEVICE_RUNNER_UNIT_TESTS
      textInputCandidateReadForTesting?(position)
#endif
      let handle = app.descendants(matching: elementType).element(boundBy: typeIndex)
      let candidate = ResolvedTextEntryInput(element: handle, snapshot: snapshot)
      let attributes = candidate.attributes
      guard isCoordinateTextInputCandidate(enabled: attributes.isEnabled, frame: attributes.frame, point: point) else {
        continue
      }
      guard let snapshot else {
        inputs.append(candidate)
        continue
      }
      // Each candidate re-runs the shared query, so an input that left the app since an earlier
      // candidate's read shifts the positions after it, and the per-type count no longer names the
      // input this candidate read. The handle must read as that input, or no position can be trusted.
      guard let handleSnapshot = try? handle.snapshot(), Self.isSameTextInput(handleSnapshot, as: snapshot) else {
        return queryTextInputsByType(app: app, point: point, shouldStop: shouldStop)
      }
      inputs.append(ResolvedTextEntryInput(element: handle, snapshot: handleSnapshot))
    }
    return inputs.sorted { smallestElementFirst($0.attributes, $1.attributes) }
  }

  /// `queryTextInputs` with one query per element type, whose handles each read through their own
  /// snapshot, for a lookup whose shared query changed while it read the candidates.
  private func queryTextInputsByType(
    app: XCUIApplication,
    point: CGPoint,
    shouldStop: () -> Bool
  ) -> [ResolvedTextEntryInput] {
    NSLog("AGENT_DEVICE_RUNNER_TEXT_INPUT_LOOKUP_BY_TYPE reason=inputs-changed-during-lookup")
    var inputs: [ResolvedTextEntryInput] = []
    for query in [app.textFields, app.secureTextFields, app.searchFields, app.textViews] {
      for element in query.allElementsBoundByIndex {
        guard !shouldStop() else { return [] }
        guard element.exists else { continue }
        let input = ResolvedTextEntryInput(element: element, snapshot: try? element.snapshot())
        let attributes = input.attributes
        if isCoordinateTextInputCandidate(enabled: attributes.isEnabled, frame: attributes.frame, point: point) {
          inputs.append(input)
        }
      }
    }
    return inputs.sorted { smallestElementFirst($0.attributes, $1.attributes) }
  }

  private static func isSameTextInput(_ read: XCUIElementSnapshot, as candidate: XCUIElementSnapshot) -> Bool {
    read.elementType == candidate.elementType
      && read.identifier == candidate.identifier
      && read.frame == candidate.frame
  }
}
