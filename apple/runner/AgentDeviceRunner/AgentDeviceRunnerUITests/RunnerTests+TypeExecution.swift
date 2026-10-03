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
      let policyKind = SynthesizedGesturePolicyKind.coordinateTap
      let context = synthesizedCoordinateContext(
        app: activeApp,
        policy: synthesizedGesturePolicy(policyKind)
      )
      switch performSynthesizedGesture(activeApp, kind: policyKind, context: context, synthesize: {
        synthesizedTapAt(app: activeApp, x: x, y: y, context: context)
      }) {
      case .performed:
        resolvedCoordinateContext = context
        resolvedCoordinateTarget = TextEntryTarget(
          element: nil,
          refreshPoint: CGPoint(x: x, y: y),
          prefersFocusedElement: false
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
          message: "text entry verification failed: expected \"\(expected)\", observed \"\(observed)\""
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
    return Response(
      ok: true,
      data: DataPayload(
        message: textResult.repaired ? "typed after repair" : "typed",
        x: point.map { Double($0.x) },
        y: point.map { Double($0.y) },
        referenceWidth: frame.isEmpty ? nil : Double(frame.width),
        referenceHeight: frame.isEmpty ? nil : Double(frame.height),
        maestroNonHittableCoordinateFallbackUsed: maestroNonHittableCoordinateFallbackUsed,
        textEntryRoute: textResult.textEntryRoute
      )
    )
  }
}
