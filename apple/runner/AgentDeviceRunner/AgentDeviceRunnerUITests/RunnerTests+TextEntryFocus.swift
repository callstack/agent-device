import XCTest

extension RunnerTests {
  /// Books the tap as the address for the next bare `type`. `element` is a text input the caller
  /// classified BEFORE dispatching, or nil when the tap hit nothing worth typing into; that is the whole
  /// contract, and this function must not re-check it. A tap holds a handle bound to the query that
  /// resolved the element, so asking the handle re-runs that query, and an element that stopped answering
  /// it — a Flutter password field once focus makes its accessibility attributes disagree — makes XCTest
  /// record a failure. That failure ends the runner session for a tap the dispatch had already landed
  /// (#3060), and ADR 0005 already keeps a tap's outcome independent of this bookkeeping.
  @MainActor
  func rememberTextEntryTap(_ element: XCUIElement?) {
    guard let element else {
      clearRememberedTextEntryTap()
      return
    }
    textEntryTapWitness = TextEntryTapWitness(
      element: element,
      bundleId: mainOwned.bundleId,
      processIdentifier: mainOwned.processIdentifier
    )
  }

  func clearRememberedTextEntryTap() {
    textEntryTapWitness = nil
  }

  @MainActor
  private func rememberedTextEntryTarget(
    contentTranslation: TextEntryContentTranslation
  ) -> TextEntryTarget? {
    guard let witness = textEntryTapWitness else {
      return nil
    }
    // The tap is proof for one immediately-following bare type only. Consume it before checking
    // the element so a failed or interrupted type cannot reuse stale focus evidence.
    clearRememberedTextEntryTap()
    guard witness.matches(
      bundleId: mainOwned.bundleId,
      processIdentifier: mainOwned.processIdentifier
    ) else {
      return nil
    }
    let element = witness.element
    // XCUIElement is query-backed rather than a stable node identity. A same-identifier field
    // introduced by app-side navigation between tap and this immediate type can therefore
    // re-resolve here; keep the witness one-shot and fail closed on every observable identity
    // boundary instead of using frame equality, which would reject legitimate layout changes.
    guard safely("LAST_TAPPED_TEXT_INPUT_EXISTS", false, { element.exists }) else {
      return nil
    }
    // Keep the target scoped to the element that the preceding tap actually selected. Do not
    // attach a refresh point: if that element disappeared, bare type must fail closed rather
    // than rediscovering a different field or dispatching unscoped app.typeText.
    return TextEntryTarget(
      element: element,
      refreshPoint: nil,
      prefersFocusedElement: false,
      contentTranslation: contentTranslation,
      fromTapWitness: true
    )
  }

  func stabilizeTextInputBeforeTyping(
    app: XCUIApplication,
    target: XCUIElement?,
    contentTranslation: TextEntryContentTranslation,
    keyboardVisibleBeforeTap: Bool? = nil
  ) -> TextEntryStabilization {
#if os(tvOS)
    return TextEntryStabilization(element: target, evidence: .focusEngine, polls: 0)
#else
    let keyboardVisibleAtEntry = keyboardVisibleBeforeTap ?? isKeyboardVisible(app: app)
    let deadline = Date().addingTimeInterval(TextEntryTiming.focusTimeout)
    var polls = 0
    while Date() < deadline {
      polls += 1
      if let focused = focusedTextInput(app: app) {
        return TextEntryStabilization(element: focused, evidence: .focusedInput, polls: polls)
      }
#if os(iOS)
      // The tapped input's own read comes before the keyboard. While a software keyboard is
      // presented, the keyboard query blocks and then finds none. An input that reports keyboard
      // focus is stronger evidence than the keyboard's arrival, which shows only that some input
      // took focus.
      let read = target.flatMap { ResolvedTextEntryInput(reading: $0, contentTranslation: contentTranslation) }
      if let read, let snapshot = read.snapshot, snapshotHasKeyboardFocus(snapshot) {
        return TextEntryStabilization(element: read.element, evidence: .inputReportsKeyboardFocus(read), polls: polls)
      }
#endif
      // focusedTextInput is intentionally nil on iOS; the keyboard transitioning to visible after
      // our tap is also a focus-moved signal. Don't fast-path when it was already up.
      if keyboardBecameVisible(app: app, wasVisibleAtEntry: keyboardVisibleAtEntry) {
        return TextEntryStabilization(element: target, evidence: .keyboardAppeared, polls: polls)
      }
#if os(iOS)
      // The read came before the keyboard query, so it is not handed on as the post-focus read.
      if let read, keyboardFocusConfirmed(app: app, read: read) {
        return TextEntryStabilization(element: target, evidence: .focusQueryMatchesInput, polls: polls)
      }
#endif
      sleepFor(TextEntryTiming.pollInterval)
    }
    return TextEntryStabilization(element: target, evidence: nil, polls: polls)
#endif
  }

  /// The point the initial focus tap dispatches: the center of the input's screen box when the
  /// read can name one, and the caller's requested point otherwise. The requested point is
  /// already a screen point, so the live `element.frame` is never dispatched: on `.unknown` it is
  /// a window-local box, and on a missing snapshot it is the read #3060 forbids (#3899).
  static func focusTapPoint(frameOnScreen: CGRect?, requestedPoint: CGPoint) -> CGPoint {
    guard let frameOnScreen, !frameOnScreen.isEmpty else { return requestedPoint }
    return .init(x: frameOnScreen.midX, y: frameOnScreen.midY)
  }

  @MainActor
  func focusTextInputForTextEntry(app: XCUIApplication, x: Double?, y: Double?) -> TextEntryTarget {
    // The one content-vector read for this command (#3899): every target built here carries it and
    // every read those targets produce converts through it.
    let contentTranslation = liveContentTranslation(app: app)
    guard let x, let y else {
      let softwareKeyboardVisible = isKeyboardVisible(app: app)
      if !softwareKeyboardVisible, let rememberedTarget = rememberedTextEntryTarget(
        contentTranslation: contentTranslation
      ) {
        return rememberedTarget
      }
      // Bare `type` targets the current first responder. On iOS we intentionally do not let the
      // app-wide `hasKeyboardFocus` query pick it, but an already-visible software keyboard is
      // sufficient evidence that app.typeText has a receiver; waiting the full readiness timeout
      // cannot prove a stronger target because there is no selector/coordinate focus move to validate.
      if softwareKeyboardVisible {
        return TextEntryTarget(
          element: focusedTextInput(app: app),
          refreshPoint: nil,
          prefersFocusedElement: true,
          contentTranslation: contentTranslation
        )
      }
      let focused = waitForTextEntryReadiness(
        app: app,
        target: TextEntryTarget(
          element: focusedTextInput(app: app),
          refreshPoint: nil,
          prefersFocusedElement: true,
          contentTranslation: contentTranslation
        )
      )
      return TextEntryTarget(
        element: focused,
        refreshPoint: nil,
        prefersFocusedElement: true,
        contentTranslation: contentTranslation
      )
    }

    let keyboardVisibleBeforeTap = isKeyboardVisible(app: app)
    let input = textInputAt(app: app, x: x, y: y, contentTranslation: contentTranslation)
    let target = input?.element
    let requestedPoint = CGPoint(x: x, y: y)
    let tapPoint = Self.focusTapPoint(frameOnScreen: input?.frameOnScreen, requestedPoint: requestedPoint)
    _ = tapAt(app: app, x: tapPoint.x, y: tapPoint.y)
    // A visible keyboard is not enough evidence for app.typeText, because focus may still
    // belong to a previous field. With a concrete target we type through XCUIElement.typeText,
    // so after tapping it the iOS readiness timeout cannot prove anything stronger.
    if keyboardVisibleBeforeTap, let target {
      return focusedTextEntryTarget(
        target,
        requestedPoint: requestedPoint,
        contentTranslation: contentTranslation
      )
    }
    let stabilized = stabilizeTextInputBeforeTyping(
      app: app,
      target: target,
      contentTranslation: contentTranslation,
      keyboardVisibleBeforeTap: keyboardVisibleBeforeTap
    )
    NSLog(
      "%@%@ polls=%d",
      TextEntryFocusEvidence.logMarker,
      stabilized.evidence?.name ?? "none",
      stabilized.polls
    )
    if case .inputReportsKeyboardFocus(let read) = stabilized.evidence {
      return focusedTextEntryTarget(
        read.element,
        read: read,
        requestedPoint: requestedPoint,
        contentTranslation: contentTranslation
      )
    }
    let readyTarget = TextEntryTarget(
      element: stabilized.element ?? target,
      refreshPoint: requestedPoint,
      prefersFocusedElement: false,
      contentTranslation: contentTranslation
    )
    let element = stabilized.focusConfirmed
      ? readyTarget.element
      : (waitForTextEntryReadiness(app: app, target: readyTarget) ?? readyTarget.element)
    return focusedTextEntryTarget(
      element,
      requestedPoint: requestedPoint,
      contentTranslation: contentTranslation
    )
  }

  /// The target the focus step hands to text entry, with the read its refresh point came from.
  private func focusedTextEntryTarget(
    _ element: XCUIElement?,
    requestedPoint: CGPoint,
    contentTranslation: TextEntryContentTranslation
  ) -> TextEntryTarget {
    guard let element else {
      return TextEntryTarget(
        element: nil,
        refreshPoint: requestedPoint,
        prefersFocusedElement: false,
        contentTranslation: contentTranslation
      )
    }
    return focusedTextEntryTarget(
      element,
      read: ResolvedTextEntryInput(reading: element, contentTranslation: contentTranslation),
      requestedPoint: requestedPoint,
      contentTranslation: contentTranslation
    )
  }

  /// `read` is `element` read after the focus tap, or nil when the read found no element.
  private func focusedTextEntryTarget(
    _ element: XCUIElement,
    read: ResolvedTextEntryInput?,
    requestedPoint: CGPoint,
    contentTranslation: TextEntryContentTranslation
  ) -> TextEntryTarget {
    return TextEntryTarget(
      element: element,
      refreshPoint: textEntryRefreshPoint(
        read: read,
        fallbackTo: requestedPoint
      ),
      prefersFocusedElement: false,
      contentTranslation: contentTranslation,
      postFocusRead: read?.snapshot == nil ? nil : read
    )
  }

  /// The field's current center for a refresh point that survives a focus move, or `requestedPoint`
  /// when the field reads with an empty frame. Read through a snapshot, not
  /// `element.frame`: this runs after the focus tap, and a field that stopped answering its
  /// resolving query on focus (#3060) turns that read into a recorded failure which ends the runner
  /// session for a focus the dispatch had already landed. When the read could not answer at all,
  /// the target gets NO refresh point rather than the pre-focus one: this route's first resolve is
  /// not yet bound to an identity, and a field that went unqueryable on focus may have moved the
  /// layout so the old point names a different input, so fail closed with a typed reason instead of
  /// typing into that other field. The frame is `read`'s snapshot frame plus its content vector,
  /// never the live `element.frame`, and `frameOnScreen` is nil for a read that cannot name a screen
  /// box (#3899, #3060).
  private func textEntryRefreshPoint(
    read: ResolvedTextEntryInput?,
    fallbackTo requestedPoint: CGPoint
  ) -> CGPoint? {
    guard let frame = read?.frameOnScreen else {
      return nil
    }
    guard !frame.isEmpty else {
      return requestedPoint
    }
    return CGPoint(x: frame.midX, y: frame.midY)
  }
}
