import XCTest
import AgentDeviceSnapshotPresentation

extension RunnerTests {
  struct RunnerAlert {
    let root: XCUIElement
    let ownerApp: XCUIApplication
    let actions: [XCUIElement]
    let source: AlertSurfaceSource
    /// The window hosting a SpringBoard modal; nil routes through `ownerApp`.
    let window: XCUIElement?
  }

  enum AlertResolution {
    case absent
    /// Required alert acquisition did not establish presence or absence.
    case unresolved
    case notActionable
    case resolved(RunnerAlert)
  }

  static let defaultAlertCommandTimeout: TimeInterval = 10

  /// One recovery sentence for every alert failure that activated nothing, so the refusal in
  /// `handleAlert` and the unactivated `alertVerificationResponse` branches cannot drift apart.
  static let alertNoButtonActivatedHint =
    "No alert button was activated. Inspect the current alert before deciding on an action."

  static let alertUnresolvedHint =
    "Alert could not finish reading the current prompt state. Inspect it with screenshot, then snapshot -i, and press @ref on the visible button."

  static func alertCommandTimeout(timeoutMs: Double?) -> TimeInterval {
    guard let timeoutMs, timeoutMs.isFinite else { return defaultAlertCommandTimeout }
    return max(0.001, timeoutMs / 1000)
  }

  @MainActor
  func resolveAlert(app activeApp: XCUIApplication, deadline: Date) -> AlertResolution {
#if AGENT_DEVICE_RUNNER_UNIT_TESTS
    if let override = alertResolutionOverrideForTesting {
      return override(deadline)
    }
#endif
    do {
#if !os(macOS)
      let systemResolution = resolveBlockingSystemModal(deadline: deadline)
      switch systemResolution {
      case .absent: break
      case .resolved, .unresolved, .notActionable: return systemResolution
      }
#endif
      let state = try readModalValue(deadline: deadline) { activeApp.state }
      guard state != .unknown else { return .unresolved }
      guard state != .notRunning else { return .absent }
      if let alert = try firstExistingElement(in: readModalElements(deadline: deadline) {
        activeApp.alerts.allElementsBoundByIndex
      }, deadline: deadline) {
        return try resolveAppAlert(root: alert, ownerApp: activeApp, source: .appAlert, deadline: deadline)
      }
      if let dialog = try firstExistingElement(in: readModalElements(deadline: deadline) {
        activeApp.otherElements.matching(identifier: AlertSurface.safariDialogIdentifier).allElementsBoundByIndex
      }, deadline: deadline) {
        return try resolveAppAlert(root: dialog, ownerApp: activeApp, source: .safariDialog, deadline: deadline)
      }
      if let popup = try firstDismissPopupWindow(in: activeApp, deadline: deadline) {
        return try resolveAppAlert(root: popup, ownerApp: activeApp, source: .dismissPopup, deadline: deadline)
      }
      return .absent
    } catch {
      return .unresolved
    }
  }

  private func resolveAppAlert(
    root: XCUIElement, ownerApp: XCUIApplication, source: AlertSurfaceSource, deadline: Date
  ) throws -> AlertResolution {
    let actions = try readModalActions(in: root, deadline: deadline)
    guard !actions.isEmpty else { return .notActionable }
    return .resolved(RunnerAlert(root: root, ownerApp: ownerApp, actions: actions, source: source, window: nil))
  }

  @MainActor
  func handleAlert(_ alert: RunnerAlert, action: String, deadline: Date) throws -> Response {
    if action == "accept" || action == "dismiss" {
      let selectedButton: XCUIElement?
      do {
        selectedButton = try chooseAlertButton(alert, action: action, deadline: deadline)
      } catch ModalReadFailure.deadlineExceeded {
        return alertVerificationResponse(.timedOut, action: action, activated: false)
      } catch {
        return alertUnresolvedResponse()
      }
      guard let button = selectedButton else {
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
      guard let outcome = try activateAlertButton(alert, button: button, action: action, frame: buttonFrame, deadline: deadline) else {
        return alertVerificationResponse(.timedOut, action: action, activated: false)
      }
      if let response = unsupportedResponse(for: outcome) {
        return response
      }
      while true {
        sleepFor(min(0.2, max(0, deadline.timeIntervalSinceNow)))
        guard let verification = RunnerAlertVerification.verify(
          original: original,
          observation: observeAlert(
            in: alert.ownerApp,
            source: alert.source,
            observesApplicationRoot: observesApplicationRoot,
            deadline: deadline
          )
        ) else { continue }
        return alertVerificationResponse(verification, action: action, activated: true)
      }
    }

    let items: [String]
    do {
      items = try readModalValue(deadline: deadline) {
        alert.actions.map { $0.label.trimmingCharacters(in: .whitespacesAndNewlines) }
      }
    } catch {
      return alertUnresolvedResponse()
    }
    let title = safely("ALERT_TITLE", "Alert") { preferredAlertTitle(alert.root, buttons: alert.actions) }
    return Response(
      ok: true,
      data: DataPayload(
        message: title,
        items: items,
        launchConfirmationPrompt: marksLaunchConfirmation(alert, title: title, items: items) ? true : nil
      )
    )
  }

  /// The launch confirmation is SpringBoard's own modal. An app alert can carry the same wording
  /// and buttons, and `open` accepts a marked alert, so the mark needs the SpringBoard source too.
  func marksLaunchConfirmation(_ alert: RunnerAlert, title: String, items: [String]) -> Bool {
    alert.source == .blockingSystemModal
      && alert.ownerApp === springboard
      && RunnerLaunchConfirmationPrompt.system.recognizes(title: title, buttons: items)
  }

  @MainActor
  func activateAlertButton(
    _ alert: RunnerAlert,
    button: XCUIElement,
    action: String,
    frame: CGRect,
    deadline: Date
  ) throws -> RunnerInteractionOutcome? {
    var outcome: RunnerInteractionOutcome?
    var activationError: Error?
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
        var hostContext: SynthesizedCoordinateContext?
        if let window = alert.window {
          // Never fall back to the owner app's first window: on a foldable it can be another panel.
          guard let context = SynthesizedCoordinateContext(
            validating: surfaceGeometry(windowFrame: safely("ALERT_WINDOW", CGRect.null) { window.frame }, app: alert.ownerApp),
            resolvedWindow: window,
            accessibilityHealth: mainOwned.accessibilityHealth
          ) else {
            outcome = .unsupported(
              message: "alert activation could not read the window hosting the alert",
              hint: "Inspect the current alert before deciding whether to act again."
            )
            return
          }
          hostContext = context
        }
        let attempt: RunnerInteractionOutcome?
        do {
          attempt = try synthesizedTapAt(
            app: alert.ownerApp,
            x: frame.midX,
            y: frame.midY,
            context: hostContext,
            deadline: deadline
          )
        } catch {
          activationError = error
          return
        }
        switch attempt {
        case .performed?:
          typealias WaitForQuiescence = @convention(c) (NSObject, Selector, Bool) -> Void
          let waitForQuiescence = unsafeBitCast(
            alert.ownerApp.method(for: postEventWaitSelector),
            to: WaitForQuiescence.self
          )
          waitForQuiescence(alert.ownerApp, postEventWaitSelector, false)
          outcome = .performed
        case .unsupported(let message, _)?, .notDispatched(let message, _)?:
          outcome = .unsupported(
            message: message,
            hint: "Inspect the current alert before deciding whether to act again."
          )
        case nil:
          break
        }
#else
        do {
          outcome = try activateElement(app: alert.ownerApp, element: button, action: "alert \(action)", resolvedFrame: frame)
        } catch {
          activationError = error
        }
#endif
      }
    }
    if let activationError { throw activationError }
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

  func alertUnresolvedResponse() -> Response {
    Response(ok: false, error: ErrorPayload(
      code: RunnerWireErrorCode.alertUnresolved,
      message: "alert could not finish reading the current prompt state",
      hint: Self.alertUnresolvedHint
    ))
  }

  private func firstExistingElement(in elements: [XCUIElement], deadline: Date) throws -> XCUIElement? {
    try elements.first { element in
      try readModalValue(deadline: deadline) { isVisibleElement(element) }
    }
  }

  /// The marker is matched inside XCTest's query, so the screen is read once per query. Reading each
  /// descendant instead costs one round trip per element, and on a screen whose tree changes while
  /// it is read (a loading web view) each vanished element adds XCTest's retry cycle. `containing`
  /// also matches a window that is itself the marker.
  private func firstDismissPopupWindow(in app: XCUIApplication, deadline: Date) throws -> XCUIElement? {
    try firstExistingElement(in: readModalElements(deadline: deadline) {
      app.windows.containing(Self.dismissPopupMarker).allElementsBoundByIndex
    }, deadline: deadline)
  }

  private static let dismissPopupMarker = NSPredicate(
    format: "label MATCHES[c] %@ OR identifier MATCHES[c] %@",
    AlertSurface.dismissPopupMarkerPattern,
    AlertSurface.dismissPopupMarkerPattern
  )

  // Internal, not private: the dismiss-popup wiring is pinned by
  // RunnerTests+AlertTests, and the label rule itself by RunnerAlertButtonChoice.
  func chooseAlertButton(_ alert: RunnerAlert, action: String, deadline: Date) throws -> XCUIElement? {
    let buttons = try readModalValue(deadline: deadline) {
      alert.actions.filter { $0.exists && $0.isEnabled }
    }
    let labels = try readModalValue(deadline: deadline) { buttons.map(\.label) }
    guard let index = RunnerAlertButtonChoice.buttonIndex(
      for: labels,
      action: action,
      popupMarkerSurface: alert.source == .dismissPopup,
      vocabulary: .system
    ) else {
      return nil
    }
    return buttons[index]
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
    return AlertSurface.isDismissPopupMarker(normalized) ||
      normalized.hasPrefix("vertical scroll bar") ||
      normalized.hasPrefix("horizontal scroll bar") ||
      normalized == "tab bar"
  }

  private func isVisibleElement(_ element: XCUIElement) -> Bool {
    element.exists && !element.frame.isNull && !element.frame.isEmpty
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
    return safely("ALERT_BUTTON_HITTABLE", false) { button.exists && button.isHittable }
  }
}
