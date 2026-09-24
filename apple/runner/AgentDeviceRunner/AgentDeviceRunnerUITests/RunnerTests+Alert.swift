import XCTest

extension RunnerTests {
  enum RunnerAlertSource {
    case blockingSystemModal
    case appAlert
    case dismissPopup
  }

  struct RunnerAlert {
    let root: XCUIElement
    let ownerApp: XCUIApplication
    let buttons: [XCUIElement]
    let source: RunnerAlertSource
  }

  static let defaultAlertCommandTimeout: TimeInterval = 10

  static func alertCommandTimeout(timeoutMs: Double?) -> TimeInterval {
    guard let timeoutMs, timeoutMs.isFinite else { return defaultAlertCommandTimeout }
    return max(0.001, timeoutMs / 1000)
  }

  func resolveAlert(app activeApp: XCUIApplication, deadline: Date) -> RunnerAlert? {
#if AGENT_DEVICE_RUNNER_UNIT_TESTS
    if let override = alertResolutionOverrideForTesting {
      return override(deadline)
    }
#endif
#if !os(macOS)
    switch resolveBlockingSystemModal(deadline: deadline) {
    case .resolved(let modal):
      return runnerAlert(modal)
    case .unresolved:
      return nil
    case .absent:
      break
    }
#endif
    // Guard the query: when a remote-hosted modal (e.g. the AccessorySetupKit
    // picker) was just dismissed, the dismissal re-check re-enters here with the
    // now-gone host as `activeApp`, and its `alerts` query raises
    // kAXErrorServerNotFound. safeElementsQuery absorbs it and reports no alert.
    if let alert = firstExistingElement(in: safeElementsQuery { activeApp.alerts.allElementsBoundByIndex }) {
      return runnerAlert(root: alert, ownerApp: activeApp, source: .appAlert)
    }
    if let popup = firstDismissPopupWindow(in: activeApp) {
      return runnerAlert(root: popup, ownerApp: activeApp, source: .dismissPopup)
    }
    return nil
  }

  func handleAlert(_ alert: RunnerAlert, action: String, deadline: Date) -> Response {
    if action == "accept" || action == "dismiss" {
      guard let button = chooseAlertButton(alert.buttons, action: action) else {
        return Response(ok: false, error: ErrorPayload(message: "alert \(action) button not found"))
      }
      guard Date() < deadline else {
        return alertVerificationResponse(.timedOut, action: action, activated: false)
      }
      guard let original = captureAlertPresentation(alert.root) else {
        return alertVerificationResponse(.unconfirmed, action: action, activated: false)
      }
      let observesApplicationRoot = alert.root.elementType == .application
      guard Date() < deadline else {
        return alertVerificationResponse(.timedOut, action: action, activated: false)
      }
      guard waitUntilAlertButtonHittable(button, deadline: deadline) else {
        return alertVerificationResponse(.timedOut, action: action, activated: false)
      }
      let buttonFrame = button.frame
      guard Date() < deadline else {
        return alertVerificationResponse(.timedOut, action: action, activated: false)
      }
#if !os(tvOS)
      guard !buttonFrame.isEmpty else {
        return alertVerificationResponse(.unconfirmed, action: action, activated: false)
      }
#endif
      NSLog(
        "AGENT_DEVICE_RUNNER_ALERT_ACTIVATION action=%@ label=%@ frame=(%.1f,%.1f,%.1f,%.1f) point=(%.1f,%.1f)",
        action,
        button.label,
        buttonFrame.origin.x, buttonFrame.origin.y, buttonFrame.size.width, buttonFrame.size.height,
        buttonFrame.midX, buttonFrame.midY
      )
      // The hittable read above is this activation's readiness gate, so XCTest's pre-synthesis waits
      // add nothing and can cost more than the command has: the tap would land after the deadline
      // expired and the alert would be answered by a button the caller was told nothing about
      // (#2546). The post-tap settle stays, because the verification below reads the alert this tap
      // replaces; an alert that dismisses and presents an identical replacement passes through a
      // window with no alert, and a first read landing there reports a dismissal nothing proved.
      guard let outcome = activateAlertButton(alert, button: button, action: action, frame: buttonFrame, deadline: deadline) else {
        return alertVerificationResponse(.timedOut, action: action, activated: false)
      }
      if let response = unsupportedResponse(for: outcome) {
        return response
      }
      while true {
        sleepFor(min(0.2, max(0, deadline.timeIntervalSinceNow)))
        let verification = RunnerAlertVerification.verify(
          original: original,
          observation: observeAlert(
            in: alert.ownerApp,
            source: alert.source,
            observesApplicationRoot: observesApplicationRoot,
            deadline: deadline
          )
        )
        if verification == .stillVisible { continue }
        return alertVerificationResponse(verification, action: action, activated: true)
      }
    }

    return Response(
      ok: true,
      data: DataPayload(
        message: preferredAlertTitle(alert.root, buttons: alert.buttons),
        items: alert.buttons.map { $0.label.trimmingCharacters(in: .whitespacesAndNewlines) }
      )
    )
  }

  func activateAlertButton(
    _ alert: RunnerAlert,
    button: XCUIElement,
    action: String,
    frame: CGRect,
    deadline: Date
  ) -> RunnerInteractionOutcome? {
    var outcome: RunnerInteractionOutcome?
    withUIInterruptionHandlingDisabledIfSupported(alert.ownerApp) {
      withBoundedInteractionIdleTimeoutIfSupported(alert.ownerApp, waits: .preEventSkipped) {
        guard Date() < deadline else { return }
#if !os(tvOS)
        guard !frame.isEmpty else { return }
#endif
        outcome = activateElement(
          app: alert.ownerApp,
          element: button,
          action: "alert \(action)",
          resolvedFrame: frame
        )
      }
    }
    return outcome
  }

  /// Before each event XCTest looks for SpringBoard elements over the target and hands them to its
  /// interruption handler, which waits up to 15 s for a notification banner to leave and taps a
  /// button of its own choosing on any other alert. An alert command answers exactly the alert it
  /// resolved, with the button it chose, before its deadline, so it opts out of both.
  private func withUIInterruptionHandlingDisabledIfSupported(_ target: XCUIApplication, operation: () -> Void) {
    let key = "doesNotHandleUIInterruptions"
    guard target.responds(to: NSSelectorFromString("setDoesNotHandleUIInterruptions:")) else {
      operation()
      return
    }
    let previous = target.value(forKey: key) as? NSNumber
    target.setValue(true, forKey: key)
    defer { target.setValue(previous?.boolValue ?? false, forKey: key) }
    operation()
  }

  private func runnerAlert(_ modal: ResolvedBlockingSystemModal) -> RunnerAlert? {
    let buttons = modal.actions.filter { isEnabledElement($0) }
    guard !buttons.isEmpty else {
      return nil
    }
    return RunnerAlert(
      root: modal.root,
      ownerApp: modal.ownerApp,
      buttons: buttons,
      source: .blockingSystemModal
    )
  }

  private func runnerAlert(
    root: XCUIElement,
    ownerApp: XCUIApplication,
    source: RunnerAlertSource
  ) -> RunnerAlert? {
    let buttons = actionableElements(in: root).filter { isEnabledElement($0) }
    guard !buttons.isEmpty else {
      return nil
    }
    return RunnerAlert(root: root, ownerApp: ownerApp, buttons: buttons, source: source)
  }

  private func firstExistingElement(in elements: [XCUIElement]) -> XCUIElement? {
    elements.first { isVisibleElement($0) }
  }

  /// The marker is matched inside XCTest's query, so the screen is read once per query. Reading each
  /// descendant instead costs one round trip per element, and on a screen whose tree changes while
  /// it is read (a loading web view) each vanished element adds XCTest's retry cycle. `containing`
  /// also matches a window that is itself the marker.
  private func firstDismissPopupWindow(in app: XCUIApplication) -> XCUIElement? {
    firstExistingElement(in: safeElementsQuery {
      app.windows.containing(Self.dismissPopupMarker).allElementsBoundByIndex
    })
  }

  /// The one definition of a popover's dismiss region: a label or identifier that reads "dismiss
  /// popup", in any case, with any surrounding whitespace. XCTest queries take it as a format predicate.
  private static let dismissPopupMarkerPattern = #"\s*dismiss popup\s*"#
  private static let dismissPopupMarker = NSPredicate(
    format: "label MATCHES[c] %@ OR identifier MATCHES[c] %@",
    dismissPopupMarkerPattern,
    dismissPopupMarkerPattern
  )
  private static let dismissPopupMarkerText = NSPredicate(format: "SELF MATCHES[c] %@", dismissPopupMarkerPattern)

  private func chooseAlertButton(_ buttons: [XCUIElement], action: String) -> XCUIElement? {
    if action == "accept" {
      if let accept = buttons.first(where: { isAcceptButton($0.label) }) {
        return accept
      }
      return buttons.count == 1 && !isDismissButton(buttons[0].label) ? buttons[0] : nil
    }

    return buttons.first(where: { isDismissButton($0.label) }) ?? buttons.last
  }

  func isAcceptButton(_ label: String) -> Bool {
    let normalized = label.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    return [
      "ok",
      "allow",
      "yes",
      "continue",
      "done",
      "open",
      "open settings"
    ].contains(normalized) || normalized.hasPrefix("confirm")
  }

  private func isDismissButton(_ label: String) -> Bool {
    [
      "cancel",
      "close",
      "dismiss",
      "don't allow",
      "don’t allow",
      "not now",
      "no",
      "keep browsing",
      "later"
    ].contains(label.trimmingCharacters(in: .whitespacesAndNewlines).lowercased())
  }

  private func preferredAlertTitle(_ element: XCUIElement, buttons: [XCUIElement]) -> String {
    let buttonLabels = Set(buttons.map { $0.label.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() })
    let descendants = element.descendants(matching: .any).allElementsBoundByIndex
    for descendant in descendants {
      let text = descendant.label.trimmingCharacters(in: .whitespacesAndNewlines)
      if text.isEmpty ||
        isGenericAlertLabel(text) ||
        buttonLabels.contains(text.lowercased()) ||
        descendant.elementType == .navigationBar ||
        actionableTypes.contains(descendant.elementType)
      {
        continue
      }
      return text
    }
    let label = element.label.trimmingCharacters(in: .whitespacesAndNewlines)
    return label.isEmpty || isGenericAlertLabel(label) ? "Alert" : label
  }

  private func isGenericAlertLabel(_ label: String) -> Bool {
    let normalized = label.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    return isDismissPopupMarker(normalized) ||
      normalized.hasPrefix("vertical scroll bar") ||
      normalized.hasPrefix("horizontal scroll bar") ||
      normalized == "tab bar"
  }

  private func isVisibleElement(_ element: XCUIElement) -> Bool {
    element.exists && !element.frame.isNull && !element.frame.isEmpty
  }

  private func isEnabledElement(_ element: XCUIElement) -> Bool {
    var enabled = false
    _ = RunnerObjCExceptionCatcher.catchException({
      enabled = element.exists && element.isEnabled
    })
    return enabled
  }

  // A snapshot can expose an alert's button a beat before the owning app has made it
  // hittable, and a starved host delays the app's layout and hit-testing further. This
  // activation is not repeated, so a tap issued into that window is dropped, the
  // presentation never changes, and the whole budget rides an unchanged alert to
  // `ALERT_DEADLINE_EXCEEDED` with no button ever activated. Spend the deadline waiting
  // for a fresh hittable read instead of spending it on a dropped tap. The hittable read
  // is itself a synchronous query a starved host can complete past the deadline, so a read
  // that lands late forfeits rather than buys back the one activation.
  private func waitUntilAlertButtonHittable(_ button: XCUIElement, deadline: Date) -> Bool {
    while Date() < deadline {
      if probeAlertButtonHittable(button, deadline: deadline) {
        return Date() < deadline
      }
      sleepFor(min(0.1, max(0, deadline.timeIntervalSinceNow)))
    }
    return false
  }

  private func probeAlertButtonHittable(_ button: XCUIElement, deadline: Date) -> Bool {
#if AGENT_DEVICE_RUNNER_UNIT_TESTS
    if let override = alertButtonHittabilityProbeOverrideForTesting {
      return override(deadline)
    }
#endif
    var hittable = false
    _ = RunnerObjCExceptionCatcher.catchException({
      hittable = button.exists && button.isHittable
    })
    return hittable
  }

  func isDismissPopupMarker(_ text: String) -> Bool {
    Self.dismissPopupMarkerText.evaluate(with: text)
  }
}
