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

  /// One recovery sentence for every alert failure that activated nothing, so the refusal in
  /// `handleAlert` and the unactivated `alertVerificationResponse` branches cannot drift apart.
  static let alertNoButtonActivatedHint =
    "No alert button was activated. Inspect the current alert before deciding on an action."

  static func alertCommandTimeout(timeoutMs: Double?) -> TimeInterval {
    guard let timeoutMs, timeoutMs.isFinite else { return defaultAlertCommandTimeout }
    return max(0.001, timeoutMs / 1000)
  }

  @MainActor
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
    let state = activeApp.state
    guard state != .notRunning && state != .unknown else {
      return nil
    }
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

  @MainActor
  func handleAlert(_ alert: RunnerAlert, action: String, deadline: Date) -> Response {
    if action == "accept" || action == "dismiss" {
      guard let button = chooseAlertButton(alert, action: action) else {
        // The choice refused before any activation, so this discloses dispatched: no like the
        // runner's other pre-run refusals.
        return Response(ok: false, error: ErrorPayload(
          code: RunnerWireErrorCode.alertButtonNotFound,
          message: "alert \(action) button not found",
          hint: RunnerTests.alertNoButtonActivatedHint
        ))
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

  @MainActor
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
#if os(iOS)
        let postEventWaitSelector = NSSelectorFromString("_waitForQuiescenceAsPreEvent:")
        guard alert.ownerApp.responds(to: postEventWaitSelector) else {
          outcome = .unsupported(
            message: "alert activation could not wait for post-event quiescence",
            hint: "Inspect the current alert before deciding whether to act again."
          )
          return
        }
        switch synthesizedTapAt(app: alert.ownerApp, x: frame.midX, y: frame.midY, deadline: deadline) {
        case .performed?:
          typealias WaitForQuiescence = @convention(c) (NSObject, Selector, Bool) -> Void
          let waitForQuiescence = unsafeBitCast(
            alert.ownerApp.method(for: postEventWaitSelector),
            to: WaitForQuiescence.self
          )
          waitForQuiescence(alert.ownerApp, postEventWaitSelector, false)
          outcome = .performed
        case .unsupported(let message, _)?:
          outcome = .unsupported(
            message: message,
            hint: "Inspect the current alert before deciding whether to act again."
          )
        case nil:
          break
        }
#else
        outcome = activateElement(
          app: alert.ownerApp,
          element: button,
          action: "alert \(action)",
          resolvedFrame: frame
        )
#endif
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

  // Internal, not private: the dismiss-popup wiring is pinned by
  // RunnerTests+AlertTests, and the label rule itself by RunnerAlertButtonChoice.
  func chooseAlertButton(_ alert: RunnerAlert, action: String) -> XCUIElement? {
    guard let index = RunnerAlertButtonChoice.buttonIndex(
      for: alert.buttons.map(\.label),
      action: action,
      popupMarkerSurface: alert.source == .dismissPopup
    ) else {
      return nil
    }
    return alert.buttons[index]
  }

  /// The alert's own title: the first non-empty static text inside the alert that is neither a
  /// button nor alert chrome, then the alert element's own label, then the first labelled
  /// descendant that is not a button or chrome. An alert presents its copy as static text, so the
  /// static-text read answers a root that carries host chrome whose accessibility label is not the
  /// alert's title (a SpringBoard sheet over the Home Screen includes the page readout).
  private func preferredAlertTitle(_ element: XCUIElement, buttons: [XCUIElement]) -> String {
    let buttonLabels = Set(buttons.map { $0.label.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() })
    let isButtonLabel: (String) -> Bool = { buttonLabels.contains($0.lowercased()) }
    if let text = firstAlertText(safeElementsQuery { element.staticTexts.allElementsBoundByIndex }, isButtonLabel: isButtonLabel) {
      return text
    }
    let label = element.label.trimmingCharacters(in: .whitespacesAndNewlines)
    if !label.isEmpty && !isGenericAlertLabel(label) {
      return label
    }
    if let text = firstAlertText(
      safeElementsQuery { element.descendants(matching: .any).allElementsBoundByIndex },
      isButtonLabel: isButtonLabel
    ) {
      return text
    }
    return "Alert"
  }

  private func firstAlertText(
    _ elements: [XCUIElement],
    isButtonLabel: (String) -> Bool
  ) -> String? {
    for element in elements {
      let text = element.label.trimmingCharacters(in: .whitespacesAndNewlines)
      if text.isEmpty || isGenericAlertLabel(text) || isButtonLabel(text) {
        continue
      }
      if element.elementType == .navigationBar || actionableTypes.contains(element.elementType) {
        continue
      }
      return text
    }
    return nil
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
  @MainActor
  private func waitUntilAlertButtonHittable(_ button: XCUIElement, deadline: Date) -> Bool {
    while Date() < deadline {
      if probeAlertButtonHittable(button, deadline: deadline) {
        return Date() < deadline
      }
      sleepFor(min(0.1, max(0, deadline.timeIntervalSinceNow)))
    }
    return false
  }

  @MainActor
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
