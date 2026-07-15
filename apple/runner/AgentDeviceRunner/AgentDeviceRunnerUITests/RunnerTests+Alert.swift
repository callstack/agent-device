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
      let previousTitle = preferredAlertTitle(alert.root, buttons: alert.buttons)
      let actionButtonLabel = button.label.trimmingCharacters(in: .whitespacesAndNewlines)
      let actionButtonFrame = button.frame
      let outcome = activateElement(app: alert.ownerApp, element: button, action: "alert \(action)")
      if let response = unsupportedResponse(for: outcome) {
        return response
      }
      sleepFor(0.2)
      if alertStillVisible(
        in: alert.ownerApp,
        source: alert.source,
        previousTitle: previousTitle,
        actionButtonLabel: actionButtonLabel,
        deadline: deadline
      ) {
        if !actionButtonFrame.isNull && !actionButtonFrame.isEmpty {
          let coordinateOutcome = tapAt(
            app: alert.ownerApp,
            x: actionButtonFrame.midX,
            y: actionButtonFrame.midY
          )
          if let response = unsupportedResponse(for: coordinateOutcome) {
            return response
          }
          sleepFor(0.2)
        }
      }
      if alertStillVisible(
        in: alert.ownerApp,
        source: alert.source,
        previousTitle: previousTitle,
        actionButtonLabel: actionButtonLabel,
        deadline: deadline
      ) {
        return Response(
          ok: false,
          error: ErrorPayload(
            code: "INTERACTION_FAILED",
            message: "alert \(action) did not dismiss the visible alert",
            hint: "The alert button was found but the system still reports the alert after tapping it."
          )
        )
      }
      return Response(ok: true, data: DataPayload(message: action == "accept" ? "accepted" : "dismissed"))
    }

    return Response(
      ok: true,
      data: DataPayload(
        message: preferredAlertTitle(alert.root, buttons: alert.buttons),
        items: alert.buttons.map { $0.label.trimmingCharacters(in: .whitespacesAndNewlines) }
      )
    )
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

  private func alertStillVisible(
    in ownerApp: XCUIApplication,
    source: RunnerAlertSource,
    previousTitle: String,
    actionButtonLabel: String,
    deadline: Date
  ) -> Bool {
    guard Date() < deadline,
          let current = resolveAlert(source: source, app: ownerApp, deadline: deadline)
    else {
      return false
    }
    let currentTitle = preferredAlertTitle(current.root, buttons: current.buttons)
    if previousTitle == currentTitle {
      return true
    }
    return current.buttons.contains { button in
      button.label.trimmingCharacters(in: .whitespacesAndNewlines) == actionButtonLabel
    }
  }

  private func resolveAlert(
    source: RunnerAlertSource,
    app: XCUIApplication,
    deadline: Date
  ) -> RunnerAlert? {
    switch source {
    case .blockingSystemModal:
#if os(macOS)
      return nil
#else
      guard case .resolved(let modal) = resolveBlockingSystemModal(deadline: deadline) else {
        return nil
      }
      return runnerAlert(modal)
#endif
    case .appAlert:
      guard let alert = firstExistingElement(
        in: safeElementsQuery { app.alerts.allElementsBoundByIndex }
      ) else {
        return nil
      }
      return runnerAlert(root: alert, ownerApp: app, source: .appAlert)
    case .dismissPopup:
      guard let popup = firstDismissPopupWindow(in: app) else {
        return nil
      }
      return runnerAlert(root: popup, ownerApp: app, source: .dismissPopup)
    }
  }

  private func firstExistingElement(in elements: [XCUIElement]) -> XCUIElement? {
    elements.first { isVisibleElement($0) }
  }

  private func firstDismissPopupWindow(in app: XCUIApplication) -> XCUIElement? {
    safeElementsQuery {
      app.windows.allElementsBoundByIndex
    }.first { window in
      if !isVisibleElement(window) { return false }
      if isDismissPopupMarker(window.label) || isDismissPopupMarker(window.identifier) {
        return true
      }
      return safeElementsQuery {
        window.descendants(matching: .any).allElementsBoundByIndex
      }.contains { descendant in
        isDismissPopupMarker(descendant.label) || isDismissPopupMarker(descendant.identifier)
      }
    }
  }

  private func chooseAlertButton(_ buttons: [XCUIElement], action: String) -> XCUIElement? {
    if action == "accept" {
      if let accept = buttons.first(where: { isAcceptButton($0.label) }) {
        return accept
      }
      return buttons.count == 1 && !isDismissButton(buttons[0].label) ? buttons[0] : nil
    }

    return buttons.first(where: { isDismissButton($0.label) }) ?? buttons.last
  }

  private func isAcceptButton(_ label: String) -> Bool {
    let normalized = label.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    return [
      "ok",
      "allow",
      "yes",
      "continue",
      "done",
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

  private func isDismissPopupMarker(_ label: String) -> Bool {
    label.trimmingCharacters(in: .whitespacesAndNewlines).caseInsensitiveCompare("dismiss popup") == .orderedSame
  }
}
