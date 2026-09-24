import AgentDeviceSnapshotPresentation
import XCTest

extension RunnerTests {
  static let navigationBackKeywords = ["back", "close", "cancel"]
  static let navigationFallbackVerificationDelay: TimeInterval = 0.25

  /// What one in-app `back` attempt concluded. `.unverified` carries the typed capture failure the
  /// display refused with, so an optional visual check that could not run reports an unknown instead
  /// of the false "no back control exists" that a `nil` sample would otherwise become (#2728).
  enum InAppBackOutcome {
    case performed
    case unavailable
    case unverified(ErrorPayload)
  }

  /// The three answers a before/after visual comparison can give. `unobserved` is not evidence of
  /// "no change": a display that refuses to be sampled proves nothing either way (#2728).
  enum NavigationVisualObservation: Equatable {
    case changed
    case unchanged
    case unobserved

    var logToken: String {
      switch self {
      case .changed: return "yes"
      case .unchanged: return "no"
      case .unobserved: return "unknown"
      }
    }
  }

  /// One navigation-fallback capture: the encoded frame when the display answered, and the typed
  /// reason it refused otherwise. Only iOS produces a refusal; other platforms capture nothing here.
  struct NavigationVisualSample {
    let data: Data?
    let refusalCode: String?
    let refusalHint: String?

    init(data: Data?, refusalCode: String? = nil, refusalHint: String? = nil) {
      self.data = data
      self.refusalCode = refusalCode
      self.refusalHint = refusalHint
    }
  }

  @MainActor
  func tapInAppBackControl(app: XCUIApplication) -> InAppBackOutcome {
#if os(macOS)
    if let back = macOSNavigationBackElement(app: app) {
      tapElementCenter(app: app, element: back)
      return .performed
    }
    return .unavailable
#elseif os(tvOS)
    _ = pressTvRemote(.menu)
    return .performed
#else
    let buttons = app.navigationBars.buttons.allElementsBoundByIndex
    if let back = buttons.first(where: { $0.isHittable }) {
      back.tap()
      return .performed
    }
    if isSnapshotXCTestChannelPenalized(bundleId: mainOwned.bundleId) {
      NSLog("AGENT_DEVICE_RUNNER_IN_APP_BACK_SKIPPED_XCTEST_ENUMERATION bundle=%@", mainOwned.bundleId ?? "")
    } else if let back = topNavigationBackElement(app: app) {
      tapElementCenter(app: app, element: back)
      return .performed
    }
    return tapTopLeadingNavigationFallback(app: app)
#endif
  }

  private func tapElementCenter(app: XCUIApplication, element: XCUIElement) {
    let frame = element.frame
    if !frame.isEmpty {
      _ = tapAt(app: app, x: frame.midX, y: frame.midY)
      return
    }
#if !os(tvOS)
    element.tap()
#endif
  }

  private func topNavigationBackElement(app: XCUIApplication) -> XCUIElement? {
#if os(iOS)
    let frame = onScreenWindowFrame(app: app)
    let candidates = app.buttons.matching(Self.navigationBackPredicate()).allElementsBoundByIndex.compactMap {
      element -> (XCUIElement, Int)? in
      guard element.exists, element.isHittable else { return nil }
      guard Self.isTopNavigationControlFrame(element.frame, in: frame) else { return nil }
      guard let rank = Self.navigationBackControlRank(
        label: element.label,
        identifier: element.identifier
      ) else {
        return nil
      }
      return (element, rank)
    }
    return candidates.sorted { lhs, rhs in
      if lhs.1 != rhs.1 { return lhs.1 < rhs.1 }
      let leftFrame = lhs.0.frame
      let rightFrame = rhs.0.frame
      if leftFrame.minY != rightFrame.minY { return leftFrame.minY < rightFrame.minY }
      return leftFrame.minX < rightFrame.minX
    }.first?.0
#else
    return nil
#endif
  }

  static func navigationBackPredicate() -> NSPredicate {
    let clauses = navigationBackKeywords.flatMap { _ in
      ["label CONTAINS[c] %@", "identifier CONTAINS[c] %@"]
    }.joined(separator: " OR ")
    let arguments = navigationBackKeywords.flatMap { [$0, $0] }
    return NSPredicate(format: clauses, argumentArray: arguments)
  }

  static func navigationBackControlRank(label: String, identifier: String) -> Int? {
    let text = "\(label) \(identifier)".lowercased()
    return navigationBackKeywords.firstIndex { text.contains($0) }
  }

  static func isTopNavigationControlFrame(_ candidate: CGRect, in window: CGRect) -> Bool {
    guard SnapshotGeometry.isPositiveFinite(candidate), SnapshotGeometry.isPositiveFinite(window)
    else {
      return false
    }
    // Accept the compact navigation/search header band without matching deep content controls.
    let maxY = window.minY + min(max(window.height * 0.22, 96), 180)
    return candidate.midY >= window.minY && candidate.midY <= maxY
  }

  static func topLeadingNavigationFallbackPoint(in frame: CGRect) -> CGPoint? {
    guard SnapshotGeometry.isPositiveFinite(frame) else {
      return nil
    }
    // Aim at the standard leading navigation slot, bounded for compact and tablet widths.
    let xOffset = min(max(frame.width * 0.08, 28), 44)
    // Sit below the status/dynamic-island region and inside common custom RN search headers.
    let yOffset = min(max(frame.height * 0.155, 56), 132)
    return CGPoint(x: frame.minX + xOffset, y: frame.minY + yOffset)
  }

  @MainActor
  private func tapTopLeadingNavigationFallback(app: XCUIApplication) -> InAppBackOutcome {
#if os(iOS)
    let frame = onScreenWindowFrame(app: app)
    guard let point = Self.topLeadingNavigationFallbackPoint(in: frame) else {
      return .unavailable
    }
    let before = captureNavigationFallbackVisualState(app: app)
    let context = synthesizedCoordinateContext(
      app: app,
      policy: synthesizedGesturePolicy(.coordinateTap)
    )?.withReferenceFrame(frame)
    switch performSynthesizedGesture(app, kind: .coordinateTap, context: context, synthesize: {
      synthesizedTapAt(app: app, x: point.x, y: point.y, context: context)
    }) {
    case .performed:
      return verifyNavigationFallbackOutcome(app: app, before: before)
    case .refused:
      return .unavailable
    case .xctestFallback:
      let fallback = performGesture(app) {
        tapAt(app: app, x: point.x, y: point.y)
      }
      if case .performed = fallback.outcome {
        return verifyNavigationFallbackOutcome(app: app, before: before)
      }
    }
#endif
    return .unavailable
  }

  private func captureNavigationFallbackVisualState(app: XCUIApplication) -> NavigationVisualSample {
#if os(iOS)
    return Self.navigationFallbackSample(
      resolvingApp: { self.captureResolvedAppScreen(app: app) },
      systemSurface: { self.captureResolvedAppScreen(app: self.springboard) },
      encoding: { runnerPngData(for: $0.image) }
    )
#else
    return NavigationVisualSample(data: nil)
#endif
  }

  /// The decision the in-app `back` fallback makes about WHAT to sample, kept apart from the live app
  /// so the decision itself is testable. It samples only the app's own resolved screen: consulting the
  /// system surface for an app that resolved no window would capture SpringBoard's home screen, which
  /// reads as "unchanged" across a before/after pair and launders a wrong-process frame into a false
  /// "no back control" — the opposite of the unknown-outcome answer the fallback owes (#2728). The
  /// system surface is still threaded in, so sampling it is the tested contract: a caller that started
  /// to consult it fails the fallback's test. `navigationVisualSample` then names the refusal.
  static func navigationFallbackSample(
    resolvingApp: () -> Result<CapturedAppScreen, RunnerAppScreenCaptureFailure>,
    systemSurface: () -> Result<CapturedAppScreen, RunnerAppScreenCaptureFailure>,
    encoding: (CapturedAppScreen) -> Data?
  ) -> NavigationVisualSample {
    _ = systemSurface
    return navigationVisualSample(from: resolvingApp(), encoding: encoding)
  }

  /// Turns a capture answer into a navigation sample: the encoded frame when the display answered,
  /// and the typed reason it refused otherwise. A resolved display whose image would not encode is
  /// named as the capture failure it is, not as an unnamed no-sample that would default to "no
  /// display resolved" (#2728). Kept apart from the query so the mapping itself is testable.
  static func navigationVisualSample(
    from outcome: Result<CapturedAppScreen, RunnerAppScreenCaptureFailure>,
    encoding: (CapturedAppScreen) -> Data?
  ) -> NavigationVisualSample {
    switch outcome {
    case .success(let captured):
      guard let png = encoding(captured) else {
        let refusal = RunnerAppScreenCaptureFailure.unrenderableImage
        return NavigationVisualSample(
          data: nil,
          refusalCode: refusal.rawValue,
          refusalHint: refusal.hint
        )
      }
      return NavigationVisualSample(data: png)
    case .failure(let failure):
      return NavigationVisualSample(
        data: nil,
        refusalCode: failure.rawValue,
        refusalHint: failure.hint
      )
    }
  }

  private func verifyNavigationFallbackOutcome(
    app: XCUIApplication,
    before: NavigationVisualSample
  ) -> InAppBackOutcome {
    sleepFor(Self.navigationFallbackVerificationDelay)
    let after = captureNavigationFallbackVisualState(app: app)
    let observation = Self.navigationVisualObservation(before: before.data, after: after.data)
    // The sample sizes and the observation name together tell a refused capture apart from an
    // unchanged screen, and the fallback is rare enough that saying so every time costs nothing.
    NSLog(
      "AGENT_DEVICE_RUNNER_IN_APP_BACK_VISUAL_VERIFICATION beforeBytes=%ld afterBytes=%ld changed=%@",
      before.data?.count ?? -1,
      after.data?.count ?? -1,
      observation.logToken
    )
    return Self.inAppBackOutcome(observation: observation, before: before, after: after)
  }

  /// What an observation of the fallback's before/after samples concludes. Kept apart from the sleep
  /// and the capture so the three-way decision is testable without a running app.
  static func inAppBackOutcome(
    observation: NavigationVisualObservation,
    before: NavigationVisualSample,
    after: NavigationVisualSample
  ) -> InAppBackOutcome {
    switch observation {
    case .changed:
      return .performed
    case .unchanged:
      return .unavailable
    case .unobserved:
      // No sample is not evidence of no navigation change: the fallback ran, so report the display
      // refusal it hit rather than laundering an unobservable result into "back is not available".
      return .unverified(Self.navigationFallbackErrorPayload(after: after, before: before))
    }
  }

  static func navigationVisualObservation(
    before: Data?,
    after: Data?
  ) -> NavigationVisualObservation {
    guard let before, let after else { return .unobserved }
    return before != after ? .changed : .unchanged
  }

  /// The refusal the fallback most recently hit wins, so the code names the last thing it looked at
  /// before giving up. A missing reason on both sides is unreachable on iOS (every nil sample carries
  /// one) and defaults to the plain display-unresolved code.
  static func navigationFallbackErrorPayload(
    after: NavigationVisualSample,
    before: NavigationVisualSample
  ) -> ErrorPayload {
    ErrorPayload(
      code:
        after.refusalCode
        ?? before.refusalCode
        ?? RunnerAppScreenCaptureFailure.unresolvedScreen.rawValue,
      message:
        "The in-app back fallback was dispatched, but no display could be sampled to confirm the result. This is an unknown outcome, not evidence that a back control is absent.",
      hint: after.refusalHint ?? before.refusalHint
    )
  }

  private func macOSNavigationBackElement(app: XCUIApplication) -> XCUIElement? {
    let predicate = NSPredicate(
      format: "identifier == %@ OR label == %@",
      "go back",
      "Back"
    )
    let element = app.descendants(matching: .any).matching(predicate).firstMatch
    return element.exists ? element : nil
  }
}
