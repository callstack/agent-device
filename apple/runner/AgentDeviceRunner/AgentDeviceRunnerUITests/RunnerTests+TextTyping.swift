import XCTest

// Text typing, verification, and repair. Kept separate from focus/readiness so each
// text-entry policy remains a bounded review surface.
extension RunnerTests {
  @MainActor
  func typeTextReliably(
    app: XCUIApplication,
    target: TextEntryTarget,
    text: String,
    delaySeconds: Double,
    repairMode: TextTypingRepairMode = .none,
    xCTestChannelPenalized: Bool = false,
    synthesizer: any TextEntrySynthesizing,
    commandId: String? = nil
  ) -> TextEntryResult {
    let totalStartedAt = Date()
    guard !text.isEmpty else {
      // Replacing a field WITH the empty string is the clear-field primitive (#2063): the typing
      // is vacuous but the clear is not. Returning here unconditionally left the old value in
      // place while the response reported "typed". Append (`type`) and unrepaired entry stay
      // no-ops, which is what an empty payload means for them.
      if repairMode == .replacement {
        guard let clearTarget = resolveTextEntryElement(app: app, target: target) else {
          // No resolvable input means no clear happened — including the synthesized
          // first-responder route, whose target carries no element. Success here would claim a
          // clear the runner never performed.
          logTextEntryPhase(commandId: commandId, phase: "total", startedAt: totalStartedAt, chars: 0, mode: repairMode)
          return TextEntryResult(
            verified: nil,
            repaired: false,
            expectedText: "",
            observedText: nil,
            failure: .notFocused
          )
        }
        clearTextInput(clearTarget)
        // nil means the value is unreadable (secure fields), not "not empty": leave `verified`
        // nil there rather than reporting a mismatch the runner cannot actually observe.
        let observed = editableTextValue(for: clearTarget, treatingPlaceholderAsEmpty: true)
        logTextEntryPhase(commandId: commandId, phase: "total", startedAt: totalStartedAt, chars: 0, mode: repairMode)
        return TextEntryResult(
          verified: observed.map { $0.isEmpty },
          repaired: false,
          expectedText: "",
          observedText: observed
        )
      }
      logTextEntryPhase(commandId: commandId, phase: "total", startedAt: totalStartedAt, chars: 0, mode: repairMode)
      return TextEntryResult(verified: true, repaired: false, expectedText: "", observedText: "")
    }
    var activeTarget = target
    if repairMode == .replacement,
      Self.shouldUseSynthesizedFirstResponderReplacement(
        hasResolvedElement: target.element != nil,
        hasRefreshPoint: target.refreshPoint != nil,
        xCTestChannelPenalized: xCTestChannelPenalized
      )
    {
      switch runSynthesizedReplacementRoute(
        SynthesizedReplacementRequest(
          app: app,
          target: target,
          text: text,
          delaySeconds: delaySeconds,
          synthesizer: synthesizer,
          commandId: commandId,
          startedAt: totalStartedAt
        )
      ) {
      case .notApplicable:
        break
      case .completed(let result):
        return result
      case .fallback(let fallbackTarget):
        activeTarget = fallbackTarget
      }
    }
    let shouldUseSynthesizedFirstResponderType = Self.shouldUseSynthesizedFirstResponderType(
      repairMode: repairMode,
      text: text,
      fromTapWitness: activeTarget.fromTapWitness,
      softwareKeyboardVisible: isKeyboardVisible(app: app)
    )
    let initialResolveStartedAt = Date()
    let initialTarget = resolveTextEntryElement(app: app, target: activeTarget)
    activeTarget = activeTarget.withElement(initialTarget)
    let currentText = editableTextValue(for: initialTarget, treatingPlaceholderAsEmpty: true)
    let initialText = repairMode == .append ? currentText : nil
    let expectedText = expectedTextEntryValue(typedText: text, mode: repairMode, initialText: initialText)
    var textEntryRoute: String?
    logTextEntryPhase(
      commandId: commandId,
      phase: "initial-resolve",
      startedAt: initialResolveStartedAt,
      chars: text.count,
      mode: repairMode
    )

    // Dispatching text through XCTest without a resolved target or evidence of a focused
    // responder records a test failure. That tears down the long-lived runner and turns a
    // single invalid request into a restart cascade, so fail before entering that channel.
    guard initialTarget != nil || (activeTarget.prefersFocusedElement && isKeyboardVisible(app: app)) else {
      logTextEntryPhase(
        commandId: commandId,
        phase: "total",
        startedAt: totalStartedAt,
        chars: text.count,
        mode: repairMode
      )
      return TextEntryResult(
        verified: nil,
        repaired: false,
        expectedText: expectedText,
        observedText: nil,
        failure: .notFocused
      )
    }

    if repairMode == .replacement {
      guard let replacementTarget = initialTarget else {
        logTextEntryPhase(commandId: commandId, phase: "total", startedAt: totalStartedAt, chars: text.count, mode: repairMode)
        return TextEntryResult(verified: nil, repaired: false, expectedText: expectedText, observedText: nil)
      }
      if currentText == nil || currentText?.isEmpty == false {
        let clearStartedAt = Date()
        clearTextInput(replacementTarget)
        activeTarget = activeTarget.withElement(replacementTarget)
        logTextEntryPhase(
          commandId: commandId,
          phase: "clear",
          startedAt: clearStartedAt,
          chars: text.count,
          mode: repairMode
        )
      }
    }

    // The shape this command posts, decided once: a spaced per-character plan, a peeled warmup plus
    // the rest, or one burst. The delivery budget below charges this array and the dispatch loops
    // below post it, so a refusal cannot come from an estimate of a plan the runner never ran
    // (#2955). The warmup peel is charged here even though only the burst route performs it, and
    // the spaced route skips it: a spaced plan already posts per character.
    let synthesizedTypePlan = Self.synthesizedTextPlan(
      characterCount: text.count,
      delaySeconds: delaySeconds,
      selectsExistingText: false,
      peelsWarmupCharacter: repairMode != .none
    )
    // One answer for the whole command, not one per post. The synthesized pace is slowed for fields
    // whose app owns the value, and a burst that long outlasts the command while the runner is still
    // posting it, so the ceiling is charged the whole command: charging the chunk instead made 215
    // characters look like 1 + 214, each inside the budget.
    let synthesizedTypeCarriesTheCommand = !SynthesizedDeliveryBudget.exceeds(synthesizedTypePlan)

    // Application-wide typing is the only channel left for this post: it is what the command's budget
    // falls back to, and what private synthesis falls back to. The route cannot read the value back
    // afterwards, so the text arrives unverified either way. The refusal is charged the whole command
    // and the post is a chunk of it, so the log names both lengths.
    func typeApplicationWide(_ value: String, reason: String) -> (element: XCUIElement?, failure: TextEntryFailure?) {
      NSLog(
        "AGENT_DEVICE_RUNNER_TEXT_ENTRY_ROUTE route=xctest-application-fallback reason=%@ chars=%d commandChars=%d",
        reason,
        value.count,
        text.count
      )
      textEntryRoute = "xctest-application-fallback"
      app.typeText(value)
      return (resolveTextEntryElement(app: app, target: activeTarget), nil)
    }

    func typeIntoCurrentTarget(_ value: String) -> (element: XCUIElement?, failure: TextEntryFailure?) {
#if os(iOS)
      if shouldUseSynthesizedFirstResponderType {
        guard let currentTarget = resolveTextEntryElement(app: app, target: activeTarget) else {
          return (nil, .notFocused)
        }
        textEntryRoute = "synthesized-first-responder"
        NSLog("AGENT_DEVICE_RUNNER_TEXT_ENTRY_ROUTE route=synthesized-first-responder")
        switch synthesizer.enterText(app: app, text: value, replacingExistingText: false) {
        case .continueTyping:
          return (currentTarget, nil)
        case .fallback:
          return (nil, .synthesisUnavailable)
        case .raise(let message):
          NSException(
            name: NSExceptionName.internalInconsistencyException,
            reason: message ?? "private XCTest text synthesis failed"
          ).raise()
        }
      }
#endif
      if let currentTarget = resolveTextEntryElement(app: app, target: activeTarget) {
        textEntryRoute = "xctest-element"
        currentTarget.typeText(value)
        return (currentTarget, nil)
      } else if activeTarget.prefersFocusedElement && isKeyboardVisible(app: app) {
#if os(iOS)
        // Two ways this post leaves the synthesized channel, and both hand the text to
        // application-wide typing: the command's own budget refused it, or XCTest's private synthesis
        // is unavailable. This branch's target has no element to type into, so nothing can be read
        // back afterwards: the value arrives unverified either way.
        guard synthesizedTypeCarriesTheCommand else {
          return typeApplicationWide(value, reason: "delivery-budget")
        }
        textEntryRoute = "synthesized-first-responder"
        NSLog("AGENT_DEVICE_RUNNER_TEXT_ENTRY_ROUTE route=synthesized-first-responder")
        switch synthesizer.enterText(app: app, text: value, replacingExistingText: false) {
        case .fallback:
          return typeApplicationWide(value, reason: "synthesis-unavailable")
        case .raise(let message):
          NSException(
            name: NSExceptionName.internalInconsistencyException,
            reason: message ?? "private XCTest text synthesis failed"
          ).raise()
        case .continueTyping:
          break
        }
#else
        app.typeText(value)
#endif
        return (resolveTextEntryElement(app: app, target: activeTarget), nil)
      }
      return (nil, .notFocused)
    }

    func dispatchFailureResult(_ failure: TextEntryFailure) -> TextEntryResult {
      TextEntryResult(
        verified: nil,
        repaired: false,
        expectedText: expectedText,
        observedText: nil,
        textEntryRoute: textEntryRoute,
        failure: failure
      )
    }

    func readBackWarmupCharacter(_ peeledCharacter: String) {
      // A route with an element reads the peeled character back and waits up to `warmupValueTimeout`
      // for the app to accept it. The route that had to be budgeted has no element, so its expected
      // value is nil and this is the plan's one charged poll.
      let warmupExpectedText = expectedTextEntryValue(
        typedText: peeledCharacter,
        mode: repairMode,
        initialText: initialText
      )
      guard let warmupExpectedText else {
        sleepFor(TextEntryTiming.pollInterval)
        return
      }
      let deadline = Date().addingTimeInterval(TextEntryTiming.warmupValueTimeout)
      while Date() < deadline {
        if editableTextValue(for: resolveTextEntryElement(app: app, target: activeTarget)) == warmupExpectedText {
          return
        }
        sleepFor(TextEntryTiming.pollInterval)
      }
    }

    // One pass over the plan the budget charged: each step posts its slice and takes the wait the
    // plan carries, so the shape a refusal was measured against is the shape dispatched (#2955).
    var typedTarget: XCUIElement?
    var sawWarmupPost = false
    var planFailure: TextEntryResult?
    var stepStartedAt = Date()
    let pacedStartedAt = Date()
    runSynthesizedTextPlan(
      synthesizedTypePlan,
      text: text,
      post: { slice, step in
        stepStartedAt = Date()
        let dispatch = typeIntoCurrentTarget(slice)
        if let failure = dispatch.failure {
          planFailure = dispatchFailureResult(failure)
          return .stop
        }
        typedTarget = dispatch.element ?? typedTarget
        if step.warmsUpField {
          // The read-back wants the element this post just typed into, not a re-resolve from scratch.
          activeTarget = activeTarget.withElement(typedTarget)
        }
        return .posted
      },
      waitAfterWarmupCharacter: { peeledCharacter in
        let warmupStartedAt = Date()
        readBackWarmupCharacter(peeledCharacter)
        logTextEntryPhase(
          commandId: commandId,
          phase: "warmup",
          startedAt: warmupStartedAt,
          chars: 1,
          mode: repairMode
        )
      },
      didPostStep: { step in
        guard !synthesizedTypePlan.pacesEveryCharacter else {
          return
        }
        let phase: String
        if step.warmsUpField {
          phase = "type-first"
          sawWarmupPost = true
        } else {
          phase = sawWarmupPost ? "type-remaining" : "type-all"
        }
        logTextEntryPhase(
          commandId: commandId,
          phase: phase,
          startedAt: stepStartedAt,
          chars: step.characterCount,
          mode: repairMode
        )
      }
    )
    if synthesizedTypePlan.pacesEveryCharacter {
      // Paced delivery is one paced burst: the phase covers every post and names the whole text
      // rather than its last character.
      logTextEntryPhase(
        commandId: commandId,
        phase: "type-delayed",
        startedAt: pacedStartedAt,
        chars: text.count,
        mode: repairMode
      )
    }
    // A stopped plan must answer before touching the target: the input can be gone by now, and the
    // element the last post returned is then unreadable. That failure is already typed.
    if let failure = planFailure {
      return failure
    }
    activeTarget = activeTarget.withElement(typedTarget)
    if repairMode == .none {
      logTextEntryPhase(commandId: commandId, phase: "total", startedAt: totalStartedAt, chars: text.count, mode: repairMode)
      return TextEntryResult(
        verified: nil,
        repaired: false,
        expectedText: nil,
        observedText: nil,
        textEntryRoute: textEntryRoute
      )
    }
    let verifyStartedAt = Date()
    var result = verifyTextEntryWithRepairIfNeeded(
      app: app,
      target: activeTarget,
      expectedText: expectedText,
      repairMode: repairMode
    )
    logTextEntryPhase(
      commandId: commandId,
      phase: "verify",
      startedAt: verifyStartedAt,
      chars: text.count,
      mode: repairMode
    )
    logTextEntryPhase(commandId: commandId, phase: "total", startedAt: totalStartedAt, chars: text.count, mode: repairMode)
    result.textEntryRoute = textEntryRoute
    return result
  }

  func logTextEntryPhase(
    commandId: String?,
    phase: String,
    startedAt: Date,
    chars: Int,
    mode: TextTypingRepairMode
  ) {
    NSLog(
      "AGENT_DEVICE_RUNNER_TEXT_ENTRY_PHASE commandId=%@ phase=%@ durationMs=%.1f chars=%d mode=%@",
      commandId ?? "",
      phase,
      Date().timeIntervalSince(startedAt) * 1000.0,
      chars,
      textEntryModeName(mode)
    )
  }

  func textEntryModeName(_ mode: TextTypingRepairMode) -> String {
    switch mode {
    case .none:
      return "none"
    case .append:
      return "append"
    case .replacement:
      return "replacement"
    }
  }

  private func verifyTextEntryWithRepairIfNeeded(
    app: XCUIApplication,
    target: TextEntryTarget,
    expectedText: String?,
    repairMode: TextTypingRepairMode
  ) -> TextEntryResult {
    let initialResult = verifyTextEntry(
      app: app,
      target: target,
      expectedText: expectedText,
      repaired: false
    )
#if os(iOS)
    guard initialResult.verified == false,
          let expectedText = initialResult.expectedText
    else {
      return initialResult
    }
    guard shouldRepairTextEntry(
      app: app,
      target: target,
      expectedText: expectedText,
      repairMode: repairMode
    ) else {
      return verifyTextEntry(
        app: app,
        target: target,
        expectedText: expectedText,
        repaired: false
      )
    }

    guard let repairTarget = resolveTextEntryElement(app: app, target: target) else {
      return initialResult
    }
    let observedText = editableTextValue(for: repairTarget) ?? ""
    NSLog(
      "AGENT_DEVICE_RUNNER_REPAIR_TEXT_ENTRY expectedLength=%d observedLength=%d",
      expectedText.count,
      observedText.count
    )
    clearTextInput(repairTarget)
    repairTarget.typeText(expectedText)
    return verifyTextEntry(
      app: app,
      target: target.withElement(repairTarget),
      expectedText: expectedText,
      repaired: true
    )
#else
    return initialResult
#endif
  }

  private func verifyTextEntry(
    app: XCUIApplication,
    target: TextEntryTarget,
    expectedText: String?,
    repaired: Bool
  ) -> TextEntryResult {
    let targetElement = resolveTextEntryElement(app: app, target: target)
    guard let expectedText else {
      return TextEntryResult(
        verified: nil,
        repaired: repaired,
        expectedText: nil,
        observedText: editableTextValue(for: targetElement)
      )
    }
    guard let observedText = editableTextValue(for: targetElement) else {
      return TextEntryResult(verified: nil, repaired: repaired, expectedText: expectedText, observedText: nil)
    }
    guard textEntryValueMatchesExpected(targetElement, observedText: observedText, expectedText: expectedText) else {
      return TextEntryResult(
        verified: false,
        repaired: repaired,
        expectedText: expectedText,
        observedText: observedText
      )
    }
    let stableDeadline = Date().addingTimeInterval(TextEntryTiming.verificationStabilityWindow)
    var latestObservedText = observedText
    while Date() < stableDeadline {
      sleepFor(TextEntryTiming.pollInterval)
      guard let nextObservedText = editableTextValue(for: resolveTextEntryElement(app: app, target: target)) else {
        return TextEntryResult(verified: nil, repaired: repaired, expectedText: expectedText, observedText: nil)
      }
      latestObservedText = nextObservedText
      guard textEntryValueMatchesExpected(
        resolveTextEntryElement(app: app, target: target),
        observedText: nextObservedText,
        expectedText: expectedText
      ) else {
        return TextEntryResult(
          verified: false,
          repaired: repaired,
          expectedText: expectedText,
          observedText: nextObservedText
        )
      }
    }
    return TextEntryResult(
      verified: true,
      repaired: repaired,
      expectedText: expectedText,
      observedText: latestObservedText
    )
  }

  private func textEntryValueMatchesExpected(
    _ element: XCUIElement?,
    observedText: String,
    expectedText: String
  ) -> Bool {
    if observedText == expectedText {
      return true
    }
    guard hasTextEntrySubmitSuffix(expectedText), element?.elementType != .textView else {
      return false
    }
    var submittedText = expectedText
    while hasTextEntrySubmitSuffix(submittedText) {
      submittedText.removeLast()
    }
    return observedText == submittedText
  }

  private func hasTextEntrySubmitSuffix(_ text: String) -> Bool {
    text.hasSuffix("\n") || text.hasSuffix("\r")
  }

  private func expectedTextEntryValue(
    typedText: String,
    mode: TextTypingRepairMode,
    initialText: String?
  ) -> String? {
    switch mode {
    case .none:
      return nil
    case .append:
      guard let initialText else {
        return nil
      }
      return initialText + typedText
    case .replacement:
      return typedText
    }
  }

  private func shouldRepairTextEntry(
    app: XCUIApplication,
    target: TextEntryTarget,
    expectedText: String,
    repairMode: TextTypingRepairMode
  ) -> Bool {
#if os(iOS)
    var latestObservedText: String?
    let deadline = Date().addingTimeInterval(TextEntryTiming.verificationStabilityWindow)
    repeat {
      guard let observedText = editableTextValue(for: resolveTextEntryElement(app: app, target: target)) else {
        return false
      }
      if textEntryValueMatchesExpected(
        resolveTextEntryElement(app: app, target: target),
        observedText: observedText,
        expectedText: expectedText
      ) {
        return false
      }
      latestObservedText = observedText
      if !isRepairableTextEntryMismatch(
        observedText: observedText,
        expectedText: expectedText,
        repairMode: repairMode
      ) {
        return false
      }
      sleepFor(TextEntryTiming.pollInterval)
    } while Date() < deadline

    guard let latestObservedText else {
      return false
    }
    guard !textEntryValueMatchesExpected(
      resolveTextEntryElement(app: app, target: target),
      observedText: latestObservedText,
      expectedText: expectedText
    ) else {
      return false
    }
    return isRepairableTextEntryMismatch(
      observedText: latestObservedText,
      expectedText: expectedText,
      repairMode: repairMode
    )
#else
    return false
#endif
  }

  private func isRepairableTextEntryMismatch(
    observedText: String,
    expectedText: String,
    repairMode: TextTypingRepairMode
  ) -> Bool {
    guard observedText != expectedText else {
      return false
    }
    if repairMode == .replacement {
      return true
    }
    return observedText.isEmpty || isLikelyDroppedCharacterTextEntryMismatch(
      observedText: observedText,
      expectedText: expectedText
    )
  }

  private func isLikelyDroppedCharacterTextEntryMismatch(observedText: String, expectedText: String) -> Bool {
    guard observedText.count < expectedText.count else {
      return false
    }
    let missingCharacterCount = expectedText.count - observedText.count
    guard missingCharacterCount <= max(2, expectedText.count / 4) else {
      return false
    }
    var expectedIndex = expectedText.startIndex
    for character in observedText {
      guard let matchIndex = expectedText[expectedIndex...].firstIndex(of: character) else {
        return false
      }
      expectedIndex = expectedText.index(after: matchIndex)
    }
    return true
  }
}
