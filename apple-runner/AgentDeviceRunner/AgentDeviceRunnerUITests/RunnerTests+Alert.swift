import XCTest

extension RunnerTests {
  struct RunnerAlert {
    let root: XCUIElement
    let ownerApp: XCUIApplication
    let buttons: [XCUIElement]
  }

  func resolveAlert(app activeApp: XCUIApplication) -> RunnerAlert? {
#if !os(macOS)
    if let systemModal = firstBlockingSystemModal(in: springboard) {
      return runnerAlert(root: systemModal, ownerApp: springboard)
    }
#endif
    if let alert = firstExistingElement(in: activeApp.alerts.allElementsBoundByIndex) {
      return runnerAlert(root: alert, ownerApp: activeApp)
    }
    if let popup = firstDismissPopupWindow(in: activeApp) {
      return runnerAlert(root: popup, ownerApp: activeApp)
    }
    return nil
  }

  func handleAlert(_ alert: RunnerAlert, action: String) -> Response {
    if action == "accept" || action == "dismiss" {
      guard let button = chooseAlertButton(alert.buttons, action: action) else {
        return Response(ok: false, error: ErrorPayload(message: "alert \(action) button not found"))
      }
      let outcome = activateElement(app: alert.ownerApp, element: button, action: "alert \(action)")
      if let response = unsupportedResponse(for: outcome) {
        return response
      }
      sleepFor(0.2)
      if alertStillVisible(alert, actionButtonLabel: button.label) {
        let frame = button.frame
        if !frame.isNull && !frame.isEmpty {
          let coordinateOutcome = tapAt(app: alert.ownerApp, x: frame.midX, y: frame.midY)
          if let response = unsupportedResponse(for: coordinateOutcome) {
            return response
          }
          sleepFor(0.2)
        }
      }
      if alertStillVisible(alert, actionButtonLabel: button.label) {
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

  private func runnerAlert(root: XCUIElement, ownerApp: XCUIApplication) -> RunnerAlert? {
    let buttons = actionableElements(in: root).filter { isEnabledElement($0) }
    guard !buttons.isEmpty else {
      return nil
    }
    return RunnerAlert(root: root, ownerApp: ownerApp, buttons: buttons)
  }

  private func alertStillVisible(_ alert: RunnerAlert, actionButtonLabel: String) -> Bool {
    guard let current = resolveAlert(app: alert.ownerApp) else {
      return false
    }
    let previousTitle = preferredAlertTitle(alert.root, buttons: alert.buttons)
    let currentTitle = preferredAlertTitle(current.root, buttons: current.buttons)
    if previousTitle == currentTitle {
      return true
    }
    let normalizedActionLabel = actionButtonLabel.trimmingCharacters(in: .whitespacesAndNewlines)
    return current.buttons.contains { button in
      button.label.trimmingCharacters(in: .whitespacesAndNewlines) == normalizedActionLabel
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
