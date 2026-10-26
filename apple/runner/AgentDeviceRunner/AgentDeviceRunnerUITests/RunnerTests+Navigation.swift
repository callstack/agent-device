import AgentDeviceSnapshotPresentation
import XCTest

extension RunnerTests {
  static let navigationBackKeywords = ["back", "close", "cancel"]
  static let systemBackButtonIdentifier = "BackButton"
  static let floatingBarBackControlMaxYFraction: CGFloat = 0.4
  static let navigationFallbackVerificationDelay: TimeInterval = 0.25

  /// What one in-app `back` attempt concluded. `.unverified` carries the typed capture failure the
  /// display refused with, so a visual check that could not run reports an unknown instead of the
  /// false "no back control exists".
  enum InAppBackOutcome {
    case performed
    case unavailable
    case unverified(ErrorPayload)
  }

  /// The three answers a before/after visual comparison can give. `unobserved` carries the typed
  /// refusal that made the pair uncomparable: a display that refuses to be sampled proves nothing
  /// either way, and reading it as "unchanged" would claim a back control is absent (#2728).
  enum NavigationVisualObservation: Equatable {
    case changed
    case unchanged
    case unobserved(refusal: RunnerAppScreenCaptureFailure)

    var logToken: String {
      switch self {
      case .changed: return "yes"
      case .unchanged: return "no"
      case .unobserved: return "unknown"
      }
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
    let rejectedQueriesBefore = navigationRejectedQueryCount()
    let buttons = app.navigationBars.buttons.allElementsBoundByIndex
    if let back = buttons.first(where: { $0.isHittable }) {
      // `isHittable` promises a hittable point, not a hittable center: a bar button partly under an
      // overlay keeps the element tap, which aims at the point XCTest computed.
      back.tap()
      return .performed
    }
    if navigationRejectedQueryCount() != rejectedQueriesBefore
      || isSnapshotXCTestChannelPenalized(bundleId: mainOwned.bundleId)
    {
      NSLog("AGENT_DEVICE_RUNNER_IN_APP_BACK_SKIPPED_XCTEST_ENUMERATION bundle=%@", mainOwned.bundleId ?? "")
    } else if let frame = topNavigationBackFrame(app: app) {
      return tapResolvedNavigationBackControl(app: app, frame: frame)
    }
    return tapTopLeadingNavigationFallback(
      app: app,
      windowQueryRejected: navigationRejectedQueryCount() != rejectedQueriesBefore
    )
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

  @MainActor
  private func tapResolvedNavigationBackControl(app: XCUIApplication, frame: CGRect) -> InAppBackOutcome {
    guard SnapshotGeometry.isPositiveFinite(frame) else { return .unavailable }
    let context = navigationTapContext(app: app)
    guard dispatchNavigationTap(app: app, point: CGPoint(x: frame.midX, y: frame.midY), context: context) else {
      return .unavailable
    }
    return .performed
  }

  @MainActor
  private func navigationTapContext(
    app: XCUIApplication,
    windowQueryRejected: Bool = false
  ) -> SynthesizedCoordinateContext? {
    synthesizedCoordinateContext(
      app: app,
      policy: synthesizedGesturePolicy(.coordinateTap),
      windowQueryRejected: windowQueryRejected
    )
  }

  /// Dispatches one navigation back tap: the synthesized gesture route first, the XCTest coordinate
  /// tap where the gesture policy allows it. True once a tap was dispatched.
  @MainActor
  private func dispatchNavigationTap(
    app: XCUIApplication,
    point: CGPoint,
    context: SynthesizedCoordinateContext?
  ) -> Bool {
    switch performSynthesizedGesture(app, kind: .coordinateTap, context: context, synthesize: {
      synthesizedTapAt(app: app, x: point.x, y: point.y, context: context)
    }) {
    case .performed:
      return true
    case .refused:
      return false
    case .xctestFallback:
      let fallback = performGesture(app) {
        tapAt(app: app, x: point.x, y: point.y)
      }
      if case .performed = fallback.outcome { return true }
      return false
    }
  }

  private func topNavigationBackFrame(app: XCUIApplication) -> CGRect? {
#if os(iOS)
    let window = onScreenWindowFrame(app: app)
    let candidates = app.buttons.matching(Self.navigationBackPredicate()).allElementsBoundByIndex.compactMap {
      element -> (frame: CGRect, rank: Int)? in
      guard element.exists, element.isHittable else { return nil }
      let frame = element.frame
      let identifier = element.identifier
      guard Self.isTopNavigationBackCandidateFrame(frame, in: window, identifier: identifier)
      else { return nil }
      guard let rank = Self.navigationBackControlRank(label: element.label, identifier: identifier)
      else { return nil }
      return (frame, rank)
    }
    return candidates.sorted { lhs, rhs in
      if lhs.rank != rhs.rank { return lhs.rank < rhs.rank }
      if lhs.frame.minY != rhs.frame.minY { return lhs.frame.minY < rhs.frame.minY }
      return lhs.frame.minX < rhs.frame.minX
    }.first?.frame
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

  /// UIKit names the system back control `BackButton`. That identity is the evidence that lets it sit
  /// below the classic header band, where the iOS 27 floating toolbar places it (#3333); keyword-only
  /// matches stay inside the band so content controls that merely say "back" are not tapped.
  static func isTopNavigationBackCandidateFrame(
    _ candidate: CGRect,
    in window: CGRect,
    identifier: String
  ) -> Bool {
    if isTopNavigationControlFrame(candidate, in: window) { return true }
    guard identifier == systemBackButtonIdentifier,
      SnapshotGeometry.isPositiveFinite(candidate), SnapshotGeometry.isPositiveFinite(window)
    else {
      return false
    }
    let maxY = window.minY + window.height * floatingBarBackControlMaxYFraction
    return candidate.midY >= window.minY && candidate.midY <= maxY
  }

  /// The point the top-leading `back` fallback aims at: the leading slot of the bar that sits
  /// directly under the top inset of the frame the tap lands in. A fraction of the frame height
  /// cannot serve both families — an iPhone 17 Pro measures a 59-pt inset with its bar at y 62-116,
  /// while an iPad Pro 11" measures 32 with its bar at y 32-86, where the iPhone's height-derived 96
  /// lands below the bar. `22` is half of UIKit's standard 44-pt top bar. The bounds keep a runtime
  /// that reports no inset inside a plausible bar, and a large inset from leaving it.
  static func topLeadingNavigationFallbackPoint(
    in frame: CGRect,
    topSafeAreaInset: CGFloat
  ) -> CGPoint? {
    guard SnapshotGeometry.isPositiveFinite(frame) else {
      return nil
    }
    // Aim at the standard leading navigation slot, bounded for compact and tablet widths.
    let xOffset = min(max(frame.width * 0.08, 28), 44)
    let yOffset = min(max(topSafeAreaInset + 22, 56), 96)
    return CGPoint(x: frame.minX + xOffset, y: frame.minY + yOffset)
  }

  /// The screen's top inset, read in-process from the runner's own window scene. The status-bar /
  /// Dynamic Island band is a screen-level fact, so the runner's full-screen host window reports the
  /// one the target app sees — and unlike any element frame it answers on a tree XCTest cannot
  /// serialize. The largest top inset among the scene's windows wins: an alert or keyboard window
  /// reports none, and the window that carries the band is the one to ask.
  private func screenTopSafeAreaInset() -> CGFloat {
    #if os(iOS)
      let insets = UIApplication.shared.connectedScenes
        .compactMap { $0 as? UIWindowScene }
        .flatMap(\.windows)
        .map(\.safeAreaInsets.top)
      let inset = insets.max() ?? 0
      NSLog("AGENT_DEVICE_RUNNER_BACK_FALLBACK_TOP_INSET read=%.1f windows=%zd", inset, insets.count)
      return inset
    #else
      return 0
    #endif
  }

  @MainActor
  private func tapTopLeadingNavigationFallback(
    app: XCUIApplication,
    windowQueryRejected: Bool
  ) -> InAppBackOutcome {
#if os(iOS)
    guard let context = navigationTapContext(app: app, windowQueryRejected: windowQueryRejected),
      let point = Self.topLeadingNavigationFallbackPoint(
        in: context.referenceFrame,
        topSafeAreaInset: screenTopSafeAreaInset()
      ) else {
      return .unavailable
    }
    let before = captureNavigationFallbackVisualState(app: app, context: context)
    guard dispatchNavigationTap(app: app, point: point, context: context) else {
      return .unavailable
    }
    return verifyNavigationFallbackOutcome(app: app, before: before, context: context)
#else
    return .unavailable
#endif
  }

  private func navigationRejectedQueryCount() -> Int {
    suppressedIssueLock.lock()
    defer { suppressedIssueLock.unlock() }
    return suppressedAxSnapshotIssueCount
  }

  /// The frame the fallback compares, encoded when the display answered and the typed refusal
  /// otherwise. It samples the app's own screen only: consulting the system surface for an app that
  /// resolved no window would capture SpringBoard's home screen, which reads as "unchanged" across a
  /// before/after pair and launders a wrong-process frame into a false "no back control" — the
  /// opposite of the unknown answer the fallback owes (#2728).
  private func captureNavigationFallbackVisualState(
    app: XCUIApplication,
    context: SynthesizedCoordinateContext
  ) -> Result<Data, RunnerAppScreenCaptureFailure> {
#if os(iOS)
    return Self.navigationVisualSample(
      from: context.resolvedWindow == nil
        ? captureSoleAppScreen(app: app)
        : captureResolvedAppScreen(app: app),
      encoding: { runnerPngData(for: $0.image) }
    )
#else
    return .failure(.unresolvedScreen)
#endif
  }

  /// Turns a capture answer into the bytes to compare. A resolved display whose image would not
  /// encode is named as the capture failure it is, not as an unnamed no-sample that would default to
  /// "no display resolved" (#2728). Kept apart from the query so the mapping itself is testable.
  static func navigationVisualSample(
    from captured: Result<CapturedAppScreen, RunnerAppScreenCaptureFailure>,
    encoding: (CapturedAppScreen) -> Data?
  ) -> Result<Data, RunnerAppScreenCaptureFailure> {
    switch captured {
    case .success(let screen):
      guard let png = encoding(screen) else { return .failure(.unrenderableImage) }
      return .success(png)
    case .failure(let failure):
      return .failure(failure)
    }
  }

  private func verifyNavigationFallbackOutcome(
    app: XCUIApplication,
    before: Result<Data, RunnerAppScreenCaptureFailure>,
    context: SynthesizedCoordinateContext
  ) -> InAppBackOutcome {
    sleepFor(Self.navigationFallbackVerificationDelay)
    let after = captureNavigationFallbackVisualState(app: app, context: context)
    let observation = Self.navigationVisualObservation(before: before, after: after)
    // The sample sizes and the observation name together tell a refused capture apart from an
    // unchanged screen, and the fallback is rare enough that saying so every time costs nothing.
    NSLog(
      "AGENT_DEVICE_RUNNER_IN_APP_BACK_VISUAL_VERIFICATION beforeBytes=%ld afterBytes=%ld changed=%@",
      (try? before.get()).map(\.count) ?? -1,
      (try? after.get()).map(\.count) ?? -1,
      observation.logToken
    )
    return Self.inAppBackOutcome(observation: observation)
  }

  /// What an observation of the fallback's before/after samples concludes. Kept apart from the sleep
  /// and the capture so the three-way decision is testable without a running app.
  static func inAppBackOutcome(observation: NavigationVisualObservation) -> InAppBackOutcome {
    switch observation {
    case .changed:
      return .performed
    case .unchanged:
      return .unavailable
    case .unobserved(let refusal):
      // No sample is not evidence of no navigation change: the fallback ran, so report the display
      // refusal it hit rather than laundering an unobservable result into "back is not available".
      return .unverified(Self.navigationFallbackErrorPayload(refusal))
    }
  }

  static func navigationVisualObservation(
    before: Result<Data, RunnerAppScreenCaptureFailure>,
    after: Result<Data, RunnerAppScreenCaptureFailure>
  ) -> NavigationVisualObservation {
    switch (before, after) {
    case (.success(let before), .success(let after)):
      return before != after ? .changed : .unchanged
    // The refusal the fallback most recently hit names the unknown, so the code names the last thing
    // it looked at before giving up. An uncomparable pair always carries one.
    case (_, .failure(let refusal)):
      return .unobserved(refusal: refusal)
    case (.failure(let refusal), _):
      return .unobserved(refusal: refusal)
    }
  }

  static func navigationFallbackErrorPayload(_ refusal: RunnerAppScreenCaptureFailure) -> ErrorPayload {
    ErrorPayload(
      code: refusal.rawValue,
      message:
        "The in-app back fallback was dispatched, but no display could be sampled to confirm the result. This is an unknown outcome, not evidence that a back control is absent.",
      hint: refusal.hint
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
