import XCTest
import AgentDeviceSnapshotPresentation

extension RunnerTests {
  @MainActor
  func executeTypeCommand(activeApp: XCUIApplication, command: Command) -> Response {
    guard let text = command.text else {
      return Response(ok: false, error: ErrorPayload(message: "type requires text"))
    }
    let delaySeconds = Double(max(command.delayMs ?? 0, 0)) / 1000.0
    let textEntryMode = resolveTextEntryMode(command)
    let target: TextEntryTarget
    var resolvedCoordinateContext: SynthesizedCoordinateContext?
    // The shared runtime has already resolved this node as non-hittable and
    // deliberately selected Maestro's coordinate compatibility route.
    let maestroNonHittableCoordinateFallbackUsed: Bool? =
      command.allowNonHittableCoordinateFallback == true && command.x != nil && command.y != nil
      ? true
      : nil
    let focusStartedAt = Date()
#if os(iOS)
    let xCTestChannelPenalized = isSnapshotXCTestChannelPenalized(bundleId: mainOwned.bundleId)
    var resolvedCoordinateTarget: TextEntryTarget?
    if Self.shouldUseResolvedCoordinateTextEntryRoute(
      repairMode: textEntryMode,
      hasX: command.x != nil,
      hasY: command.y != nil,
      xCTestChannelPenalized: xCTestChannelPenalized
    ), let x = command.x, let y = command.y {
      // Resolved before the tap: the focus it causes can move the field away from this point.
      // A replacement with no input at the point has nothing to bind to: its clear and its typed
      // text would reach the app-level first responder, so an empty point and a lookup that cannot
      // answer both refuse here, each under its own reason.
      let contentTranslation = liveContentTranslation(app: activeApp)
      let inputAtPoint: TextInputAtPoint
      switch coordinateTapTextInputIdentityAt(app: activeApp, x: x, y: y, contentTranslation: contentTranslation) {
      case .input(let input):
        inputAtPoint = input
      case .absent:
        return noTextInputAtPointResponse()
      case .unavailable:
        return textInputProbeUnavailableResponse()
      }
      let policyKind = SynthesizedGesturePolicyKind.coordinateTap
      let context = synthesizedCoordinateContext(app: activeApp)
      switch performSynthesizedGesture(activeApp, kind: policyKind, context: context, synthesize: {
        synthesizedTapAt(app: activeApp, x: x, y: y, context: context)
      }) {
      case .performed:
        resolvedCoordinateContext = context
        resolvedCoordinateTarget = TextEntryTarget(
          element: nil,
          refreshPoint: CGPoint(x: x, y: y),
          prefersFocusedElement: false,
          contentTranslation: contentTranslation,
          inputAtRefreshPoint: inputAtPoint
        )
      case .xctestFallback:
        break
      case .refused(_, let message, let hint):
        return unsupportedResponse(message: message, hint: hint)
      }
    }
#else
    let xCTestChannelPenalized = false
    let resolvedCoordinateTarget: TextEntryTarget? = nil
#endif
    if let resolvedCoordinateTarget {
      target = resolvedCoordinateTarget
    } else {
      target = focusTextInputForTextEntry(app: activeApp, x: command.x, y: command.y)
    }
    NSLog(
      "AGENT_DEVICE_RUNNER_TEXT_ENTRY_PHASE commandId=%@ phase=focus durationMs=%.1f chars=%d mode=%@",
      command.commandId ?? "",
      Date().timeIntervalSince(focusStartedAt) * 1000.0,
      text.count,
      textEntryModeName(textEntryMode)
    )
    if textEntryMode == .replacement {
#if os(iOS)
      let canReplaceResolvedFirstResponder = Self.shouldUseSynthesizedFirstResponderReplacement(
        hasResolvedElement: target.element != nil,
        hasRefreshPoint: target.refreshPoint != nil,
        xCTestChannelPenalized: xCTestChannelPenalized
      )
#else
      let canReplaceResolvedFirstResponder = false
#endif
      guard target.element != nil || canReplaceResolvedFirstResponder else {
        let message =
          (command.x != nil && command.y != nil)
          ? "no text input found at the provided coordinates to clear"
          : "no focused text input to clear"
        return Response(ok: false, error: ErrorPayload(message: message))
      }
    }
    let textResult = typeTextReliably(
      app: activeApp,
      target: target,
      text: text,
      delaySeconds: delaySeconds,
      repairMode: textEntryMode,
      xCTestChannelPenalized: xCTestChannelPenalized,
      synthesizer: PrivateXCTestTextEntrySynthesizer(),
      commandId: command.commandId
    )
    if let failure = textResult.failure {
      return Response(
        ok: false,
        error: ErrorPayload(code: failure.rawValue, message: failure.message, hint: failure.hint)
      )
    }
    if textResult.verified == false {
      let expected = textResult.expectedText ?? ""
      let observed = textResult.observedText ?? ""
      return Response(
        ok: false,
        error: ErrorPayload(
          code: "TEXT_ENTRY_MISMATCH",
          message: "text entry read-back did not match: expected \"\(expected)\", observed \"\(observed)\"",
          hint: textEntryMode == .replacement
            ? "The app may have formatted, filtered, or consumed the entry. Inspect the field or resulting screen before retrying. If it needs correction, retry fill with the full text and --delay-ms \(TextEntryTiming.recoveryDelayMilliseconds)."
            : nil
        )
      )
    }
    let point = target.refreshPoint
    let frame: CGRect
    if let resolvedCoordinateContext {
      frame = resolvedCoordinateContext.referenceFrame
    } else if point != nil {
      frame = activeApp.frame
    } else {
      // Bare `type` has no coordinate response to normalize. Avoid serializing the
      // application AX tree only to emit unused reference dimensions.
      frame = .zero
    }
    var data = DataPayload(
      message: textResult.repaired ? "typed after repair" : "typed",
      x: point.map { Double($0.x) },
      y: point.map { Double($0.y) },
      referenceWidth: frame.isEmpty ? nil : Double(frame.width),
      referenceHeight: frame.isEmpty ? nil : Double(frame.height),
      maestroNonHittableCoordinateFallbackUsed: maestroNonHittableCoordinateFallbackUsed,
      textEntryRoute: textResult.textEntryRoute
    )
    if let unconfirmed = textResult.unconfirmed {
      data.verification = "unconfirmed"
      data.requested = unconfirmed.requested
      data.before = unconfirmed.before
      data.after = unconfirmed.after
      data.target = TextEntryVerificationTargetPayload(
        resourceId: unconfirmed.target.identifier,
        className: unconfirmed.target.elementType,
        packageName: command.appBundleId,
        rect: SnapshotRect(unconfirmed.target.frame)
      )
    }
    return Response(ok: true, data: data)
  }

  /// The refusal of a coordinate `fill` whose point identified no text input, answered before the
  /// focus tap is dispatched so nothing runs. Without an input at the point the synthesized
  /// replacement has no element to bind to, so its clear and its typed text would reach the app-level
  /// first responder and overwrite whatever field currently holds focus.
  private func noTextInputAtPointResponse() -> Response {
    Response(
      ok: false,
      error: ErrorPayload(
        code: RunnerWireErrorCode.noTextInputAtPoint,
        message: "no text input identified at the provided coordinates",
        hint: "A fill replaces the text of the input under its point, so the point must sit inside one — for a ref or selector fill, that point is the centre of the rect it resolved to, which an outer container or a non-input node does not give you. Run snapshot -i, pick the input node itself, and aim at a point inside its rect."
      )
    )
  }

  /// The refusal of a coordinate `fill` whose point the input lookup could not read, answered before
  /// the focus tap so nothing runs. The channel is degraded, so the runner cannot tell whether an
  /// input is there; typing would reach the app-level first responder, which is what #1721 refuses.
  private func textInputProbeUnavailableResponse() -> Response {
    Response(
      ok: false,
      error: ErrorPayload(
        code: RunnerWireErrorCode.textInputProbeUnavailable,
        message: "the runner could not read the text input at the provided coordinates",
        hint: "The accessibility lookup for the point could not answer on the degraded channel, so the runner dispatched nothing and no field changed — this does not mean the point has no input. Retry the fill, or run snapshot -i and fill the input node by ref once its capture reads back."
      )
    )
  }
}
