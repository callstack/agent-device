import AgentDeviceSnapshotPresentation
import XCTest

extension RunnerTests {
  /// UIKit's identifier for a navigation bar's system back button, in UIKit and SwiftUI stacks alike.
  static let navigationBarBackButtonIdentifier = "BackButton"
  /// The wait from the end of the swipe's contact to the sample it is compared against. An
  /// interactive pop follows the contact across most of the width, so the screen has already moved.
  static let backSwipeVerificationDelay: TimeInterval = 0.1
  /// The pause between two settle samples; a capture itself takes about 0.1 s on a simulator.
  static let backSwipeSettleSampleInterval: TimeInterval = 0.05
  /// The time the contact itself is allowed in the gap from the sample taken just before the swipe to
  /// the one after it. Both are resolved before that sample: a simulator's edge touch runs a 100 ms
  /// contact, and a device's synthesized fling runs 200 ms.
#if targetEnvironment(simulator)
  static let backGestureAllowanceMs = 200.0
#else
  static let backGestureAllowanceMs = 400.0
#endif
  /// The least time settling may sample before back swipes anyway and reports the outcome
  /// unverified; `backSwipeSettleBudgetMs` extends it on a host that captures slowly.
  static let backSwipeSettleBaseBudgetMs = 2000.0

  /// How long settling may sample: the base budget, or, when longer, the time a still screen needs
  /// to settle at the slowest capture seen: the first capture, the required still span, and one more
  /// pause and capture for the sample that completes the span. A slow host still settles a still
  /// screen instead of always reporting it unverified.
  static func backSwipeSettleBudgetMs(maxCaptureMs: Double) -> Double {
    let sampleIntervalMs = backSwipeSettleSampleInterval * 1000 + maxCaptureMs
    return max(
      backSwipeSettleBaseBudgetMs,
      maxCaptureMs + backSwipeRequiredStillMs(maxCaptureMs: maxCaptureMs) + sampleIntervalMs
    )
  }

  /// How long the screen must agree with itself before the swipe: as long as the gap it will be
  /// credited across, the contact allowance, one verification delay, and the slowest capture seen
  /// while settling. A slow host captures slowly, so it settles for longer instead of reading a real
  /// pop as unverified. `backSwipeGapIsCovered` still refuses a swipe whose actual gap outran it.
  static func backSwipeRequiredStillMs(maxCaptureMs: Double) -> Double {
    backGestureAllowanceMs + backSwipeVerificationDelay * 1000 + maxCaptureMs
  }

  /// What one `back` concluded. `.refused` dispatched nothing. `.unconfirmed` ran the back gesture,
  /// or may have, without proof that it navigated back.
  enum InAppBackOutcome {
    case performed
    case refused(ErrorPayload)
    case unconfirmed(ErrorPayload)
  }

  /// The back swipe's duration, the `right-edge` preset's `GESTURE_FLING_DURATION_MS`.
  static let backSwipeDurationMs = 100.0

  /// The back swipe's endpoints across `surface`. Mirrors the `right-edge` fling preset
  /// (`buildSwipePresetGesturePlan` and `clampGestureCoordinate` in packages/contracts/src/scroll-gesture.ts):
  /// 1% to 85% of the width at half the height, truncated, then held 8 pt inside the edges.
  /// contracts/fixtures/back-swipe-geometry.json holds both sides to the same table.
  static func backSwipeEndpoints(in surface: CGRect) -> (start: CGPoint, end: CGPoint) {
    func axis(_ size: CGFloat, percent: CGFloat) -> CGFloat {
      let margin: CGFloat = 8
      let upper = max(margin, (size - margin).rounded())
      return min(upper, max(margin, (size * percent / 100).rounded(.towardZero)))
    }
    let y = surface.minY + axis(surface.height, percent: 50)
    return (
      CGPoint(x: surface.minX + axis(surface.width, percent: 1), y: y),
      CGPoint(x: surface.minX + axis(surface.width, percent: 85), y: y)
    )
  }

  /// The three answers a before/after visual comparison can give. `unobserved` carries the typed
  /// refusal that made the pair uncomparable: a display that refuses to be sampled proves nothing
  /// either way, and reading it as "unchanged" would claim the swipe did nothing.
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

  /// iOS `back` presses the navigation bar's system back button when exactly one is on screen, read
  /// from the live tree in this call, and confirms that the bar changed. Otherwise it is the
  /// left-edge back swipe, verified by a change of the app's screen. No other button counts,
  /// whatever its label.
  @MainActor
  func performInAppBack(app: XCUIApplication) throws -> InAppBackOutcome {
#if os(macOS)
    guard let back = macOSNavigationBackElement(app: app) else {
      return .refused(ErrorPayload(message: "in-app back control is not available"))
    }
    let frame = back.frame
    if frame.isEmpty {
      back.tap()
    } else {
      _ = try tapAt(app: app, x: frame.midX, y: frame.midY)
    }
    return .performed
#elseif os(tvOS)
    _ = pressTvRemote(.menu)
    return .performed
#elseif os(iOS)
    // One line on every exit, a refusal before the swipe and a thrown error included.
    var trace = BackSwipeTrace()
    do {
      guard let context = try synthesizedCoordinateContext(app: app) else {
        let outcome = InAppBackOutcome.refused(Self.backScreenRefusal(.unresolvedWindow))
        NSLog("AGENT_DEVICE_RUNNER_BACK_SWIPE_VERIFICATION %@", trace.logLine(outcome: outcome))
        return outcome
      }
      if let pressed = try pressNavigationBarBackButton(app: app, context: context) {
        return pressed
      }
      let outcome = try verifiedBackSwipe(app: app, context: context, trace: &trace)
      NSLog("AGENT_DEVICE_RUNNER_BACK_SWIPE_VERIFICATION %@", trace.logLine(outcome: outcome))
      return outcome
    } catch {
      NSLog("AGENT_DEVICE_RUNNER_BACK_SWIPE_VERIFICATION %@", trace.logLine(name: "error", code: String(describing: type(of: error))))
      throw error
    }
#else
    // visionOS has no edge swipe that pops a navigation stack. The daemon refuses it at the back
    // capability fact, so this answers only a direct runner request, with nothing sent.
    return .refused(
      ErrorPayload(
        code: RunnerWireErrorCode.backSwipeNotDispatched,
        message: "visionOS has no back gesture",
        hint: "iOS back is a left-edge swipe; visionOS has none. Press the visible back control by its ref."
      )
    )
#endif
  }

#if os(iOS)
  /// What one iOS back measured, logged as one line whatever it concluded, so a failure on a slow
  /// host can be read from the runner log.
  struct BackSwipeTrace {
    var settleSamples = 0
    var settled = false
    var maxCaptureMs = 0.0
    var stableMs: Double?
    var gestureMs: Double?
    var justBeforeToAfterMs: Double?
    var changed: NavigationVisualObservation?

    func logLine(outcome: InAppBackOutcome) -> String {
      switch outcome {
      case .performed: return logLine(name: "performed", code: nil)
      case .refused(let payload): return logLine(name: "refused", code: payload.code)
      case .unconfirmed(let payload): return logLine(name: "unconfirmed", code: payload.code)
      }
    }

    func logLine(name: String, code: String?) -> String {
      func ms(_ value: Double?) -> String { value.map { String(Int($0.rounded())) } ?? "-" }
      return [
        "outcome=\(name)",
        "code=\(code ?? "-")",
        "changed=\(changed?.logToken ?? "-")",
        "stableMs=\(ms(stableMs))",
        "justBeforeToAfterMs=\(ms(justBeforeToAfterMs))",
        "gestureMs=\(ms(gestureMs))",
        "maxCaptureMs=\(ms(maxCaptureMs))",
        "settleSamples=\(settleSamples)",
        "settled=\(settled)",
      ].joined(separator: " ")
    }
  }

  /// Presses the navigation bar's system back button when exactly one hittable one is on screen,
  /// and confirms that the bar changed. It is read only where the tree answers queries: on a tree
  /// XCTest cannot serialize, the query would grind through XCTest's retries, so back swipes there.
  /// Two candidates, such as a sheet over a stack, are ambiguous and fall back to the swipe too. Nil
  /// when nothing was sent, so the swipe is still safe; a delivered tap is never followed by a swipe.
  @MainActor
  private func pressNavigationBarBackButton(
    app: XCUIApplication,
    context: SynthesizedCoordinateContext
  ) throws -> InAppBackOutcome? {
    var trace = NavigationBarBackTrace()
    // One line on every exit, a thrown tap included.
    defer {
      NSLog("AGENT_DEVICE_RUNNER_BACK_NAVIGATION_BAR_BUTTON %@", trace.logLine)
#if AGENT_DEVICE_RUNNER_UNIT_TESTS
      lastNavigationBarBackTraceForTesting = trace
#endif
    }
    guard navigationBarBackButtonIsReadable(context: context) else { return nil }
    let started = currentUptimeMs()
    let frames = navigationBarBackButtonFrames(app: app)
    let before = frames?.count == 1 ? readNavigationBarBackState(app: app, phase: .lookup) : nil
    trace.lookupMs = currentUptimeMs() - started
    guard let frames, frames.count == 1 else {
      trace.found = frames == nil ? "unreadable" : frames!.isEmpty ? "no" : "ambiguous"
      return nil
    }
    guard let before else {
      trace.found = "unreadable"
      return nil
    }
    trace.found = "yes"
    let frame = frames[0]
    // The synthesized tap returns once the touch is delivered; an XCTest tap would also wait out the
    // pop animation, which the bar check below reads sooner.
    switch try performSynthesizedTapGesture(app: app, x: frame.midX, y: frame.midY, context: context) {
    case .performed:
      break
    case .xctestFallback:
      let fallback = try performGesture(app) { try tapAt(app: app, x: frame.midX, y: frame.midY, context: context) }
      // A refused XCTest tap sent nothing either.
      guard case .performed = fallback.outcome else { return nil }
    case .refused:
      return nil
    }
    trace.pressed = true
    let tapped = currentUptimeMs()
    let confirmed = navigationBarBackStateChanged(app: app, from: before)
    trace.confirmMs = currentUptimeMs() - tapped
    trace.confirmed = confirmed
    return confirmed ? .performed : .unconfirmed(Self.navigationBarBackUnverified)
  }

  /// What the back button path saw, logged as one line on every exit.
  struct NavigationBarBackTrace {
    /// `skipped` when the tree was not read, `unreadable` when a read failed, `no`, `ambiguous`, or `yes`.
    var found = "skipped"
    var pressed = false
    var confirmed: Bool?
    var lookupMs = 0.0
    var confirmMs: Double?

    var logLine: String {
      func ms(_ value: Double?) -> String { value.map { String(Int($0.rounded())) } ?? "-" }
      return [
        "found=\(found)",
        "pressed=\(pressed ? "yes" : "no")",
        "confirmed=\(confirmed.map { $0 ? "yes" : "no" } ?? "-")",
        "lookupMs=\(ms(lookupMs))",
        "confirmMs=\(ms(confirmMs))",
      ].joined(separator: " ")
    }
  }

  /// Each navigation bar's identifier (the top screen's title in UIKit and SwiftUI stacks) with the
  /// label and frame of its system back buttons. A pop removes, moves, or relabels the pressed button
  /// or retitles its bar, so a change of this state is the evidence that the tap navigated.
  struct NavigationBarBackState: Equatable {
    let entries: [String]
  }

  /// The pause between two reads of the bar after the tap, and how long they may run before the
  /// outcome is reported unconfirmed. Only a tap that did not navigate spends the whole budget.
  static let navigationBarBackConfirmInterval: TimeInterval = 0.05
  static let navigationBarBackConfirmBudgetMs = 1000.0

  static let navigationBarBackUnverified = ErrorPayload(
    code: RunnerWireErrorCode.backSwipeUnverified,
    message: "back pressed the navigation bar back button, but the navigation bar did not change within 1 s. This is an unknown outcome.",
    hint: "Take a snapshot to see where the app is."
  )

  /// Whether a later read of the bar differs from `before` within the confirmation budget. A read
  /// that fails proves nothing, so it never confirms.
  @MainActor
  private func navigationBarBackStateChanged(app: XCUIApplication, from before: NavigationBarBackState) -> Bool {
    let started = currentUptimeMs()
    repeat {
      if let after = readNavigationBarBackState(app: app, phase: .confirmation), after != before { return true }
      if currentUptimeMs() - started >= Self.navigationBarBackConfirmBudgetMs { return false }
      sleepFor(Self.navigationBarBackConfirmInterval)
    } while true
  }

  @MainActor
  private func navigationBarBackButtonIsReadable(context: SynthesizedCoordinateContext) -> Bool {
    guard !context.treeUnreadable, context.accessibilityHealth != .unavailable else { return false }
    return !isSnapshotXCTestChannelPenalized(bundleId: mainOwned.bundleId)
  }

  /// Which side of the tap a read of the bar is on: a held issue in the lookup means no button, so
  /// back swipes; one in the confirmation proves nothing, so it never confirms.
  enum NavigationBarBackReadPhase {
    case lookup
    case confirmation
  }

  /// Runs one read of the bar with its XCTest issues held. A button gone mid-transition or a hung
  /// query records an issue, and an unheld issue would turn the command into a recorded failure.
  /// Nil when the read recorded an issue or raised an exception.
  @MainActor
  private func heldNavigationBarRead<T>(_ phase: NavigationBarBackReadPhase, _ read: () -> T?) -> T? {
    var value: T?
    let held = holdingRecordedIssues {
      value = read()
#if AGENT_DEVICE_RUNNER_UNIT_TESTS
      if navigationBarBackReadIssueForTesting == phase {
        record(XCTIssue(type: .assertionFailure, compactDescription: "Back button vanished during the navigation bar read"))
      }
#endif
    }
    guard held.issues.isEmpty, held.exceptionMessage == nil else { return nil }
    return value
  }

  /// The frames of the hittable system back buttons; nil when the tree did not answer.
  @MainActor
  private func navigationBarBackButtonFrames(app: XCUIApplication) -> [CGRect]? {
    heldNavigationBarRead(.lookup) {
      guard let bars = try? elementQueries(app: app, matching: .navigationBar) else { return nil }
      let frames = bars
        .flatMap { $0.buttons.matching(identifier: Self.navigationBarBackButtonIdentifier).allElementsBoundByIndex }
        .filter { $0.isHittable }
        .map(\.frame)
      return frames.allSatisfy(SnapshotGeometry.isPositiveFinite) ? frames : nil
    }
  }

  /// One XCTest snapshot per bar, so a read after the tap costs a query per bar rather than one per
  /// attribute. Nil when the tree did not answer.
  @MainActor
  private func readNavigationBarBackState(
    app: XCUIApplication,
    phase: NavigationBarBackReadPhase
  ) -> NavigationBarBackState? {
    heldNavigationBarRead(phase) {
      guard let bars = try? elementQueries(app: app, matching: .navigationBar) else { return nil }
      var entries: [String] = []
      for bar in bars.flatMap({ $0.allElementsBoundByIndex }) {
        guard let snapshot = try? bar.snapshot() else { return nil }
        entries.append(Self.navigationBarBackEntry(snapshot))
      }
      return NavigationBarBackState(entries: entries)
    }
  }

  static func navigationBarBackEntry(_ bar: XCUIElementSnapshot) -> String {
    var buttons: [String] = []
    var pending = bar.children
    while let element = pending.popLast() {
      if element.identifier == navigationBarBackButtonIdentifier {
        buttons.append("\(element.label)\u{1F}\(NSCoder.string(for: element.frame))")
      }
      pending.append(contentsOf: element.children)
    }
    return ([bar.identifier] + buttons).joined(separator: "\u{1E}")
  }

  @MainActor
  private func verifiedBackSwipe(
    app: XCUIApplication,
    context: SynthesizedCoordinateContext,
    trace: inout BackSwipeTrace
  ) throws -> InAppBackOutcome {
    // Everything but the contact is resolved before settling, so the last still sample is the one
    // the change is measured from and the swipe follows it at once.
    let dispatchGesture: @MainActor () throws -> TouchDispatch
    switch try prepareBackGesture(app: app, context: context) {
    case .ready(let dispatch): dispatchGesture = dispatch
    case .notSent(let message, let hint):
      return .refused(ErrorPayload(code: RunnerWireErrorCode.backSwipeNotDispatched, message: message, hint: hint))
    }
    let before: SettledBackSample
    switch settledBackVisualState(app: app, context: context, trace: &trace) {
    case .success(let settled): before = settled
    case .failure(let refusal): return .refused(Self.backScreenRefusal(refusal))
    }
    let justBeforeMs = before.sampledMs
    trace.stableMs = justBeforeMs - before.stableSinceMs
    let dispatch = try dispatchGesture()
    trace.gestureMs = currentUptimeMs() - justBeforeMs
    if let refusal = Self.backGestureRefusal(dispatch) {
      return refusal
    }
    guard before.settled else {
      return .unconfirmed(
        Self.backSwipeUnverified(
          because: "the app's screen was already changing on its own",
          hint: "Take a snapshot to see where the app is."
        )
      )
    }
    sleepFor(Self.backSwipeVerificationDelay)
    let after = timedBackCapture(app: app, context: context, trace: &trace)
    let afterMs = currentUptimeMs()
    trace.justBeforeToAfterMs = afterMs - justBeforeMs
    let observation = Self.navigationVisualObservation(before: .success(before.sample), after: after)
    trace.changed = observation
    guard Self.backSwipeGapIsCovered(
      stableSinceMs: before.stableSinceMs,
      justBeforeMs: justBeforeMs,
      afterMs: afterMs
    ) else {
      return .unconfirmed(
        Self.backSwipeUnverified(
          because: "the swipe took longer than the screen had been still before it",
          hint: "Take a snapshot to see where the app is."
        )
      )
    }
    return Self.backSwipeOutcome(observation: observation)
  }

  /// One back sample, with its capture time kept for the trace.
  @MainActor
  private func timedBackCapture(
    app: XCUIApplication,
    context: SynthesizedCoordinateContext,
    trace: inout BackSwipeTrace
  ) -> Result<Data, RunnerAppScreenCaptureFailure> {
    let started = currentUptimeMs()
    let sample = captureBackVisualState(app: app, context: context)
    trace.maxCaptureMs = max(trace.maxCaptureMs, currentUptimeMs() - started)
    return sample
  }
  /// A swipe refused before touch-down reached nothing; one cut short after it may have navigated.
  static func backGestureRefusal(_ dispatch: TouchDispatch) -> InAppBackOutcome? {
    switch dispatch {
    case .sent:
      return nil
    case .notSent(let message, let hint):
      return .refused(ErrorPayload(code: RunnerWireErrorCode.backSwipeNotDispatched, message: message, hint: hint))
    case .interrupted(let message, _):
      return .unconfirmed(
        backSwipeUnverified(
          because: "it was cut short after it touched down (\(message))",
          hint: "Check the screen with snapshot before you retry; the swipe may already have navigated."
        )
      )
    }
  }
#endif

  /// No screen to compare means no proof either way, so the swipe is not sent.
  static func backScreenRefusal(_ refusal: RunnerAppScreenCaptureFailure) -> ErrorPayload {
    ErrorPayload(
      code: refusal.rawValue,
      message: "back did not swipe: the app's screen could not be sampled to verify it.",
      hint: refusal.hint
    )
  }

#if os(iOS)
  /// The last settle sample: the baseline the swipe's change is measured from. `stableSinceMs` is
  /// when the run of agreeing samples it ends began, and `sampledMs` when it was captured.
  struct SettledBackSample {
    let sample: Data
    let stableSinceMs: Double
    let sampledMs: Double
    let settled: Bool
  }

  /// Samples `backSwipeSettleSampleInterval` apart until every sample of a run has agreed with its
  /// first one for `backSwipeRequiredStillMs` of the slowest capture so far. `settled` is false when
  /// `backSwipeSettleBudgetMs` of the slowest capture so far ran out first.
  @MainActor
  private func settledBackVisualState(
    app: XCUIApplication,
    context: SynthesizedCoordinateContext,
    trace: inout BackSwipeTrace
  ) -> Result<SettledBackSample, RunnerAppScreenCaptureFailure> {
    let started = currentUptimeMs()
    var runStart: (sample: Data, ms: Double)?
    while true {
      if trace.settleSamples > 0 { sleepFor(Self.backSwipeSettleSampleInterval) }
      trace.settleSamples += 1
      let sample: Data
      switch timedBackCapture(app: app, context: context, trace: &trace) {
      case .failure(let refusal): return .failure(refusal)
      case .success(let captured): sample = captured
      }
      let now = currentUptimeMs()
      let start = runStart.flatMap { Self.visualSamplesDiffer($0.sample, sample) ? nil : $0 } ?? (sample: sample, ms: now)
      runStart = start
      if now - start.ms >= Self.backSwipeRequiredStillMs(maxCaptureMs: trace.maxCaptureMs) {
        trace.settled = true
        return .success(SettledBackSample(sample: sample, stableSinceMs: start.ms, sampledMs: now, settled: true))
      }
      if now - started >= Self.backSwipeSettleBudgetMs(maxCaptureMs: trace.maxCaptureMs) {
        return .success(SettledBackSample(sample: sample, stableSinceMs: start.ms, sampledMs: now, settled: false))
      }
    }
  }
#endif

  /// The app's screen as a coarse grayscale grid when the display answered, and the typed refusal
  /// otherwise; the comparison leaves out the fixed top band (`backCompareTopRowsIgnored`), where the
  /// status bar changes on its own. It samples the app's own screen only: a system-surface capture
  /// reads as "unchanged" across a before/after pair and launders a wrong-process frame into a false
  /// refusal.
  private func captureBackVisualState(
    app: XCUIApplication,
    context: SynthesizedCoordinateContext
  ) -> Result<Data, RunnerAppScreenCaptureFailure> {
#if os(iOS)
    return Self.navigationVisualSample(
      // A lit-panel request never takes the sole-screen route: a foldable has no sole screen.
      from: context.resolvedWindow == nil && requestLitPanel == nil
        ? captureSoleAppScreen(app: app)
        : captureResolvedAppScreen(app: app, litPanel: requestLitPanel),
      encoding: { runnerCGImage(from: $0.image).flatMap(Self.visualGrid) }
    )
#else
    return .failure(.unresolvedScreen)
#endif
  }

  /// Turns a capture answer into the bytes to compare. A resolved display whose image would not
  /// encode is named as the capture failure it is, not as an unnamed no-sample that would default to
  /// "no display resolved". Kept apart from the query so the mapping itself is testable.
  static func navigationVisualSample(
    from captured: Result<CapturedAppScreen, RunnerAppScreenCaptureFailure>,
    encoding: (CapturedAppScreen) -> Data?
  ) -> Result<Data, RunnerAppScreenCaptureFailure> {
    captured.flatMap { screen in
      guard let png = encoding(screen) else { return .failure(.unrenderableImage) }
      return .success(png)
    }
  }

  static let visualGridSize = (width: 48, height: 96)
  /// The top rows of the grid the comparison never reads, so in portrait the status bar, the clock,
  /// and the Dynamic Island cannot count as a change, visible or hidden. In landscape the iPhone
  /// status bar is hidden and the Dynamic Island sits at a side edge, outside this band. The tallest
  /// phone status bar is 62 pt on an 874 pt screen, 7.1% of the height; 7 of 96 rows is 7.3%. iPad,
  /// notched, and home-button screens carry smaller fractions. A back navigation replaces most of the
  /// screen below this band.
  static let backCompareTopRowsIgnored = 7
  static let visualCellTolerance = 24
  static let visualChangedCellFraction = 0.01


  /// The screen drawn into a small grayscale grid, top row first. A back navigation redraws most of
  /// it, while a spinner, a caret, or a material shimmer moves few cells or moves them by little.
  static func visualGrid(of image: CGImage) -> Data? {
    let (width, height) = visualGridSize
    var cells = [UInt8](repeating: 0, count: width * height)
    let drawn = cells.withUnsafeMutableBytes { buffer -> Bool in
      guard let context = CGContext(
        data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8,
        bytesPerRow: width, space: CGColorSpaceCreateDeviceGray(),
        bitmapInfo: CGImageAlphaInfo.none.rawValue
      ) else { return false }
      context.interpolationQuality = .medium
      context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
      return true
    }
    return drawn ? Data(cells) : nil
  }

  /// Two grids differ when, below the top `backCompareTopRowsIgnored` rows, more than 1% of the cells
  /// moved by more than the tolerance.
  static func visualSamplesDiffer(_ lhs: Data, _ rhs: Data) -> Bool {
    guard lhs.count == rhs.count else { return true }
    let ignored = min(lhs.count, backCompareTopRowsIgnored * visualGridSize.width)
    let compared = zip(lhs.dropFirst(ignored), rhs.dropFirst(ignored))
    let moved = compared.reduce(0) { count, pair in
      abs(Int(pair.0) - Int(pair.1)) > visualCellTolerance ? count + 1 : count
    }
    return Double(moved) > Double(lhs.count - ignored) * visualChangedCellFraction
  }

  /// Whether the screen had been still for at least as long as the swipe's gap: the time from the
  /// sample taken just before the swipe to the one after it must not exceed the time the screen had
  /// already agreed with itself, or a self-repainting screen slower than the window could read as the
  /// swipe's effect. All three times are taken when a capture completed, so a slow capture counts on
  /// both sides.
  static func backSwipeGapIsCovered(stableSinceMs: Double, justBeforeMs: Double, afterMs: Double) -> Bool {
    afterMs - justBeforeMs <= justBeforeMs - stableSinceMs
  }

  /// What an observation of the swipe's before/after samples concludes. Kept apart from the sleep
  /// and the capture so the three-way decision is testable without a running app.
  static func backSwipeOutcome(observation: NavigationVisualObservation) -> InAppBackOutcome {
    switch observation {
    case .changed:
      return .performed
    case .unchanged:
      return .unconfirmed(
        ErrorPayload(
          code: RunnerWireErrorCode.backSwipeNoChange,
          message: "The back swipe changed nothing.",
          hint: "Press the visible back or close control by its ref from a fresh snapshot."
        )
      )
    case .unobserved(let refusal):
      return .unconfirmed(
        backSwipeUnverified(because: "the app's screen could not be sampled afterwards", hint: refusal.hint)
      )
    }
  }

  static func backSwipeUnverified(because reason: String, hint: String?) -> ErrorPayload {
    ErrorPayload(
      code: RunnerWireErrorCode.backSwipeUnverified,
      message: "The back swipe ran, but \(reason). This is an unknown outcome.",
      hint: hint
    )
  }

  static func navigationVisualObservation(
    before: Result<Data, RunnerAppScreenCaptureFailure>,
    after: Result<Data, RunnerAppScreenCaptureFailure>
  ) -> NavigationVisualObservation {
    switch (before, after) {
    case (.success(let before), .success(let after)):
      return visualSamplesDiffer(before, after) ? .changed : .unchanged
    // The refusal most recently hit names the unknown. An uncomparable pair always carries one.
    case (_, .failure(let refusal)):
      return .unobserved(refusal: refusal)
    case (.failure(let refusal), _):
      return .unobserved(refusal: refusal)
    }
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
