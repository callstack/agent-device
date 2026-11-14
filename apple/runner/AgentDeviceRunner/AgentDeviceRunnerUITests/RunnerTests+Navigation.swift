import AgentDeviceSnapshotPresentation
import XCTest

extension RunnerTests {
  /// UIKit's identifier for a navigation bar's system back button, in UIKit and SwiftUI stacks alike.
  /// The button is not always inside the bar's subtree: a floating one, such as the detail column's on
  /// the iPhone Duo, is a sibling of the bar. It is therefore read from the app's windows.
  static let navigationBarBackButtonIdentifier = "BackButton"
  /// The wait from the end of the swipe's contact to the sample it is compared against. An
  /// interactive pop follows the contact across most of the width, so the screen has already moved.
  /// It only bounds how soon that sample is taken; the still span does not depend on it.
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
  /// The still span's margin beyond the contact and the slowest capture. A screen that repaints
  /// itself less often than the span looks still, and its next repaint after the swipe reads as a
  /// back. 250 ms makes the span about 0.55 s on a simulator, so such a repaint every 0.5 s is
  /// caught as changing. It is deliberately independent of `backSwipeVerificationDelay`, so a
  /// faster after-sample does not weaken the guard.
  static let backSwipeStillMarginMs = 250.0

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

  /// How long the screen must agree with itself before the swipe: the contact allowance, the still
  /// margin, and the slowest capture seen while settling. That is longer than the gap the swipe is
  /// credited across (contact, verification delay, capture). A slow host captures slowly, so it
  /// settles for longer instead of reading a real pop as unverified. `backSwipeGapIsCovered` still
  /// refuses a swipe whose actual gap outran it.
  static func backSwipeRequiredStillMs(maxCaptureMs: Double) -> Double {
    backGestureAllowanceMs + backSwipeStillMarginMs + maxCaptureMs
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
    // The swipe logs one line on every exit, a refusal before it and a thrown error included. The
    // button path logs its own line on every exit, a thrown tap included.
    var trace = BackSwipeTrace()
    func logSwipe(_ line: String) { NSLog("AGENT_DEVICE_RUNNER_BACK_SWIPE_VERIFICATION %@", line) }
    let resolved: SynthesizedCoordinateContext?
    do {
      resolved = try synthesizedCoordinateContext(app: app)
    } catch {
      logSwipe(trace.logLine(name: "error", code: String(describing: type(of: error))))
      throw error
    }
    guard let context = resolved else {
      let outcome = InAppBackOutcome.refused(Self.backScreenRefusal(.unresolvedWindow))
      logSwipe(trace.logLine(outcome: outcome))
      return outcome
    }
    if let pressed = try pressNavigationBarBackButton(app: app, context: context) {
      return pressed
    }
    do {
      let outcome = try verifiedBackSwipe(app: app, context: context, trace: &trace)
      logSwipe(trace.logLine(outcome: outcome))
      return outcome
    } catch {
      logSwipe(trace.logLine(name: "error", code: String(describing: type(of: error))))
      throw error
    }
#else
    // visionOS has no back command. The daemon refuses it at the back capability fact, so this
    // answers only a direct runner request, with nothing sent.
    return .refused(
      ErrorPayload(
        code: RunnerWireErrorCode.backSwipeNotDispatched,
        message: "visionOS has no back command",
        hint: "Press the visible back control by its ref."
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

  /// Presses the system back button when exactly one hittable one is on screen and the app shows a
  /// navigation bar, and confirms that the state changed. The button is read from the app's windows:
  /// a floating one, such as the iPhone Duo's, is not inside the bar. One with no label under bars
  /// with no title could not be confirmed, so it is not pressed. It is read only where the tree answers queries: on a tree
  /// XCTest cannot serialize, the query would grind through XCTest's retries, so back swipes there.
  /// Two candidates, such as a sheet over a stack, are ambiguous and fall back to the swipe too, as
  /// does a bar still moving after the read budget. Nil when nothing was sent, so the swipe is still
  /// safe; a delivered tap is never followed by a swipe. A hung XCTest query answers without either.
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
    let lookup = stillNavigationBarBackButton(
      app: app,
      geometry: context.geometry,
      deadlineMs: started + Self.navigationBarBackReadBudgetMs
    )
    trace.lookupMs = currentUptimeMs() - started
    let before: NavigationBarBackState
    let frame: CGRect
    switch lookup {
    case .still(let state, let button):
      before = state
      frame = button
    case .notFound(let found):
      trace.found = found
      return nil
    case .hung:
      trace.found = "hung"
      return .refused(Self.navigationBarBackHungLookup)
    }
    trace.found = "yes"
    // The synthesized tap returns once the touch is delivered; an XCTest tap would also wait out the
    // pop animation, which the bar check below reads sooner. On iOS a readable tree's XCTest tap
    // either runs or throws, so its fallback needs no outcome check.
    switch try performSynthesizedTapGesture(app: app, x: frame.midX, y: frame.midY, context: context) {
    case .performed:
      break
    case .xctestFallback:
      _ = try performGesture(app) { try tapAt(app: app, x: frame.midX, y: frame.midY, context: context) }
    case .refused:
      return nil
    }
    trace.pressed = true
    let tapped = currentUptimeMs()
    let confirmation = navigationBarBackConfirmation(
      app: app,
      from: before,
      windowHeight: context.geometry.windowOnScreen.rect.height,
      deadlineMs: tapped + Self.navigationBarBackReadBudgetMs
    )
    trace.confirmMs = currentUptimeMs() - tapped
    trace.confirmed = confirmation.logToken
    switch confirmation {
    case .changed: return .performed
    case .unchanged: return .unconfirmed(Self.navigationBarBackUnverified)
    case .hung: return .unconfirmed(Self.navigationBarBackHungConfirmation)
    }
  }

  /// What the back button path saw, logged as one line on every exit.
  struct NavigationBarBackTrace {
    /// `skipped` when the tree was not read, `unreadable` when a read failed, `hung` when an XCTest
    /// query hung, `moving` when the bar did not hold still within the read budget, `no`,
    /// `ambiguous`, `unprovable` (a back button with no label under bars with no title), or `yes`.
    var found = "skipped"
    var pressed = false
    /// `yes`, `no`, or `hung`; nil until a tap was delivered.
    var confirmed: String?
    var lookupMs = 0.0
    var confirmMs: Double?

    var logLine: String {
      func ms(_ value: Double?) -> String { value.map { String(Int($0.rounded())) } ?? "-" }
      return [
        "found=\(found)",
        "pressed=\(pressed ? "yes" : "no")",
        "confirmed=\(confirmed ?? "-")",
        "lookupMs=\(ms(lookupMs))",
        "confirmMs=\(ms(confirmMs))",
      ].joined(separator: " ")
    }
  }

  /// The number of navigation bars, the labels of the system back buttons in tree order, and the
  /// frames of those buttons. The buttons' labels and frames must agree for a still bar before the tap.
  /// Bar titles are part of the state only for a back button with no label, such as the iPhone Duo's
  /// floating one, which shows no pop on its own: the state then holds each bar's title (its
  /// identifier, which UIKit sets to the title, or its label when the identifier is empty), the titles
  /// must agree before the tap, and a title change after it shows a pop. For a labeled button titles
  /// are left out, because a bar can retitle itself, such as a countdown, without any navigation. The
  /// state read decides this itself, so the state before the tap and each one after it follow one rule.
  /// Limit: on the Duo no structural signal shows every pop (closed, the button and one bar stay after
  /// a pop). So under an unlabeled button a bar that retitles itself can be misread as a pop: one that
  /// retitles more slowly than the still check samples passes it, and after the tap a single changed
  /// read counts as a pop for the whole confirmation window.
  struct NavigationBarBackState: Equatable {
    var barCount: Int
    let backButtonLabels: [String]
    let backButtonFrames: [CGRect]
    var barTitles: [String] = []

    var hasUnlabeledBackButton: Bool { backButtonLabels.contains(where: \.isEmpty) }

    func hasSameButtons(as other: NavigationBarBackState) -> Bool {
      backButtonLabels == other.backButtonLabels && backButtonFrames == other.backButtonFrames
    }

    /// Whether a pop can show in a later read of this rule: every back button has a label, or a bar
    /// has a title. Without it a tap could not be confirmed, so it is not sent.
    var canShowAPop: Bool { !hasUnlabeledBackButton || barTitles.contains { !$0.isEmpty } }
  }

  /// Whether the bar after the tap shows a pop: the bar count, the back button count, a back
  /// button label, or, for a back button with no label, a bar title changed. Frames are left out: a
  /// tap that navigates nowhere can still move the button, such as by a large-title collapse or a bar button that appears. A pop that keeps the
  /// same back button labels and bar count answers unverified, except under an unlabeled button,
  /// where a title change shows it.
  static func navigationBarBackPopped(from before: NavigationBarBackState, to after: NavigationBarBackState) -> Bool {
    after.barCount != before.barCount || after.backButtonLabels != before.backButtonLabels
      || after.barTitles != before.barTitles
  }

  /// The pause between two reads of the bar, and how long reads may start, both before the tap
  /// while the bar settles and after it while the pop is confirmed. Only a bar that never holds
  /// still, or a tap that did not navigate, spends the whole budget.
  static let navigationBarBackReadInterval: TimeInterval = 0.05
  static let navigationBarBackReadBudgetMs = 1000.0

  static let navigationBarBackUnverified = ErrorPayload(
    code: RunnerWireErrorCode.backSwipeUnverified,
    message: "back pressed the navigation bar back button, but the navigation bar's back buttons did not change within 1 s or on one more read after it. This is an unknown outcome.",
    hint: "Take a snapshot to see where the app is."
  )

  static let navigationBarBackHungConfirmation = ErrorPayload(
    code: RunnerWireErrorCode.backSwipeUnverified,
    message: "back pressed the navigation bar back button, but an XCTest query on the navigation bar hung afterwards. This is an unknown outcome.",
    hint: "Take a snapshot to see where the app is."
  )

  static let navigationBarBackHungLookup = ErrorPayload(
    code: RunnerWireErrorCode.backSwipeNotDispatched,
    message: "back sent nothing: an XCTest query on the navigation bar hung before the back button or the swipe.",
    hint: "Take a snapshot to check that the app responds, then retry back."
  )

  /// What the read before the tap found: a still bar with its one hittable back button, no button
  /// to press (with the trace's `found` value), or a hung query.
  enum NavigationBarBackLookup {
    case still(NavigationBarBackState, button: CGRect)
    case notFound(String)
    case hung
  }

  /// Reads the back buttons by a navigation bar, one snapshot per button, until two reads in a row, one
  /// read interval apart, agree, so a push still animating is not read as the state a pop changes. A
  /// button that is not by a bar is no candidate: it is neither counted nor compared. The bars (their
  /// frames, count and, under an unlabeled candidate, titles) are read by the first round and then by
  /// the live read, which checks that exactly one candidate is hittable and that its frame is in the
  /// state; the two bar reads must agree too, so a title that changes on its own is not still.
  /// Rounds start only until `deadlineMs`; each live read has a read budget of its own.
  @MainActor
  private func stillNavigationBarBackButton(
    app: XCUIApplication,
    geometry: SurfaceGeometry,
    deadlineMs: Double
  ) -> NavigationBarBackLookup {
    let windowHeight = geometry.windowOnScreen.rect.height
    var previous: NavigationBarBackState?
    var barsRead: (state: NavigationBarBackState, bars: [NavigationBarSnapshot])?
    while true {
      let sample: NavigationBarBackSample
      switch readNavigationBarBack(
        app: app, phase: .lookup, deadlineMs: deadlineMs, windowHeight: windowHeight, knownBars: barsRead?.bars
      ) {
      case .hung: return .hung
      case .unreadable: return .notFound("unreadable")
      case .read(let read): sample = read
      }
      let candidates = sample.candidates(by: sample.bars)
      if candidates.isEmpty { return .notFound("no") }
      let current = sample.state(of: candidates, bars: nil)
      let buttonsStill = previous.map { current.hasSameButtons(as: $0) } ?? false
      if sample.barsWereRead {
        barsRead = (sample.state(of: candidates, bars: sample.bars), sample.bars)
      } else if !buttonsStill {
        barsRead = nil
      }
      if buttonsStill, let barsBefore = barsRead?.state {
        // The live read is one bounded read of its own: it must not inherit what the rounds spent.
        let liveDeadlineMs = currentUptimeMs() + Self.navigationBarBackReadBudgetMs
        switch liveNavigationBarBackButton(of: sample, geometry: geometry, deadlineMs: liveDeadlineMs) {
        case .hung: return .hung
        case .unreadable: return .notFound("unreadable")
        case .read(.absent(let found)): return .notFound(found)
        case .read(.found(let state, let button, let bars)):
          if state == barsBefore { return .still(state, button: button) }
          barsRead = (state, bars)
        case .read(.moving): break
        }
      }
      if currentUptimeMs() >= deadlineMs { return .notFound("moving") }
      previous = current
      sleepFor(Self.navigationBarBackReadInterval)
    }
  }

  /// What the live read of a still state found.
  enum NavigationBarBackLive {
    case found(NavigationBarBackState, CGRect, [NavigationBarSnapshot])
    case absent(String)
    case moving
  }

  /// One live read of the sampled buttons: the bars, the candidates by them, and which candidates are
  /// hittable. A pop that the candidates could not show is not tapped.
  @MainActor
  private func liveNavigationBarBackButton(
    of sample: NavigationBarBackSample,
    geometry: SurfaceGeometry,
    deadlineMs: Double
  ) -> NavigationBarBackRead<NavigationBarBackLive> {
    heldNavigationBarRead(.lookup) {
      let bars = sample.roots.flatMap { $0.descendants(matching: .navigationBar).allElementsBoundByIndex }
      guard let snapshots = barSnapshots(bars, deadlineMs: deadlineMs) else { return nil }
      let candidates = sample.candidates(by: snapshots)
      let hittable = candidates.filter { sample.buttons[$0].isHittable }
      if hittable.isEmpty { return .absent("no") }
      if hittable.count > 1 { return .absent("ambiguous") }
      let button = sample.buttons[hittable[0]].frame
      guard SnapshotGeometry.isPositiveFinite(button) else { return nil }
      let state = sample.state(of: candidates, bars: snapshots)
      if !state.canShowAPop { return .absent("unprovable") }
      return Self.navigationBarBackState(state, holdsButton: button, geometry: geometry)
        ? .found(state, button, snapshots) : .moving
    }
  }

  /// Whether `state` holds the live button. A live frame is in screen points, and a snapshot frame
  /// is in the window's own space, which a placed iPad window starts off the screen origin (#3899).
  static func navigationBarBackState(
    _ state: NavigationBarBackState,
    holdsButton button: CGRect,
    geometry: SurfaceGeometry
  ) -> Bool {
    state.backButtonFrames.contains { frame in
      let origin = geometry.screenPoint(from: SurfacePoint<WindowContentSpace>(frame.origin)).point
      return CGRect(origin: origin, size: frame.size) == button
    }
  }

  enum NavigationBarBackConfirmation {
    case changed
    case unchanged
    case hung

    var logToken: String {
      switch self {
      case .changed: return "yes"
      case .unchanged: return "no"
      case .hung: return "hung"
      }
    }
  }

  /// Whether a later read of the bar differs from `before`. Reads start until `deadlineMs`, and
  /// unless one of them confirmed or hung, one final read starts after it with no deadline: a read
  /// of a bar that vanishes mid-pop can spend the whole budget in XCTest's retries. A read in
  /// flight ends at XCTest's own query timeout, which is a hung query. A read that fails proves
  /// nothing, so it never confirms.
  @MainActor
  private func navigationBarBackConfirmation(
    app: XCUIApplication,
    from before: NavigationBarBackState,
    windowHeight: CGFloat,
    deadlineMs: Double
  ) -> NavigationBarBackConfirmation {
    while true {
      let isFinalRead = currentUptimeMs() >= deadlineMs
      let readDeadlineMs = isFinalRead ? Double.infinity : deadlineMs
      let phase: NavigationBarBackReadPhase = isFinalRead ? .finalConfirmation : .confirmation
      switch readNavigationBarBack(
        app: app, phase: phase, deadlineMs: readDeadlineMs, windowHeight: windowHeight, knownBars: nil
      ) {
      case .read(let after)
      where Self.navigationBarBackPopped(
        from: before, to: after.state(of: after.candidates(by: after.bars), bars: after.bars)
      ):
        return .changed
      case .hung: return .hung
      case .read, .unreadable: break
      }
      if isFinalRead { return .unchanged }
      sleepFor(min(Self.navigationBarBackReadInterval, max(0, deadlineMs - currentUptimeMs()) / 1000))
    }
  }

  @MainActor
  private func navigationBarBackButtonIsReadable(context: SynthesizedCoordinateContext) -> Bool {
    guard !context.treeUnreadable, context.accessibilityHealth != .unavailable else { return false }
    return !isSnapshotXCTestChannelPenalized(bundleId: mainOwned.bundleId)
  }

  /// The phase a bar read belongs to: the lookup before the tap, a confirmation read after it, or the
  /// final confirmation read. The read passes it to the test read hook.
  enum NavigationBarBackReadPhase {
    case lookup
    case confirmation
    case finalConfirmation
  }

  /// One read of the bar: its value, a read that proved nothing, or an XCTest query that hung.
  enum NavigationBarBackRead<Value> {
    case read(Value)
    case unreadable
    case hung
  }

  /// Runs one read of the bar with its XCTest issues held. A button gone mid-transition records an
  /// issue that the read explains: the read proves nothing. A hung query is recorded again, as
  /// `record(_:)` requires, and no further query is sent into it.
  @MainActor
  private func heldNavigationBarRead<T>(_ phase: NavigationBarBackReadPhase, _ read: () -> T?) -> NavigationBarBackRead<T> {
    var value: T?
    let held = holdingRecordedIssues {
      value = read()
#if AGENT_DEVICE_RUNNER_UNIT_TESTS
      if let description = navigationBarBackReadForTesting?(phase) {
        record(XCTIssue(type: .assertionFailure, compactDescription: description))
      }
#endif
    }
    let hung = held.issues.filter { Self.isHungQueryIssueDescription($0.compactDescription) }
    hung.forEach { record($0) }
    if !hung.isEmpty { return .hung }
    guard held.issues.isEmpty, held.exceptionMessage == nil, let value else { return .unreadable }
    return .read(value)
  }

  /// One read of every `BackButton` and the bars: the buttons and their snapshots, and the bars the
  /// candidates are judged by. A candidate is a button by a bar, so an in-content `BackButton` is
  /// neither counted nor compared. The elements stay so that a live read does not query them again.
  struct NavigationBarBackSample {
    let buttons: [XCUIElement]
    let labels: [String]
    /// Snapshot frames, in the same space as the bars'.
    let frames: [CGRect]
    let roots: [XCUIElement]
    let bars: [NavigationBarSnapshot]
    let barsWereRead: Bool
    let windowHeight: CGFloat

    func candidates(by bars: [NavigationBarSnapshot]) -> [Int] {
      let barFrames = bars.map(\.frame)
      return buttons.indices.filter {
        RunnerTests.backButtonBelongsToABar(frames[$0], barFrames: barFrames, windowHeight: windowHeight)
      }
    }

    /// The candidates' state, with the bars read when given.
    func state(of candidates: [Int], bars: [NavigationBarSnapshot]?) -> NavigationBarBackState {
      let state = NavigationBarBackState(
        barCount: 0, backButtonLabels: candidates.map { labels[$0] }, backButtonFrames: candidates.map { frames[$0] })
      return bars.map { RunnerTests.addingBars($0, to: state) } ?? state
    }
  }

  /// One walk of the app's windows, then one query for the back buttons and one snapshot per button,
  /// so a read stays well inside the read budget. The bars are read too unless `knownBars` gives them:
  /// the rounds that wait for a still state read them once, and the live read reads them again.
  /// Unreadable when the tree did not answer or the read budget ran out before a snapshot.
  @MainActor
  private func readNavigationBarBack(
    app: XCUIApplication,
    phase: NavigationBarBackReadPhase,
    deadlineMs: Double,
    windowHeight: CGFloat,
    knownBars: [NavigationBarSnapshot]?
  ) -> NavigationBarBackRead<NavigationBarBackSample> {
    guard currentUptimeMs() < deadlineMs else { return .unreadable }
    return heldNavigationBarRead(phase) {
      guard let roots = try? elementSearchRoots(root: app, litDisplayID: requestLitPanel?.displayID) else { return nil }
      let buttons = roots.flatMap {
        $0.descendants(matching: .button).matching(identifier: Self.navigationBarBackButtonIdentifier).allElementsBoundByIndex
      }
      var labels: [String] = []
      var frames: [CGRect] = []
      for button in buttons {
        guard currentUptimeMs() < deadlineMs, let snapshot = try? button.snapshot() else { return nil }
        labels.append(snapshot.label)
        frames.append(snapshot.frame)
      }
      var bars = knownBars
      if bars == nil {
        let elements = roots.flatMap { $0.descendants(matching: .navigationBar).allElementsBoundByIndex }
        bars = barSnapshots(elements, deadlineMs: deadlineMs)
      }
      guard let bars else { return nil }
      return NavigationBarBackSample(
        buttons: buttons, labels: labels, frames: frames, roots: roots, bars: bars,
        barsWereRead: knownBars == nil, windowHeight: windowHeight
      )
    }
  }

  /// Whether a back button is by a navigation bar, both frames in one coordinate space: inside it, as
  /// on an iPhone, or below it within a third of the window's height from the bar's top, where the
  /// iPhone Duo floats its button (43 pt below the bar when open, 93 pt when closed), horizontally
  /// within the bar. An in-content button elsewhere, or in an app with no bar, is not the system back
  /// button.
  static func backButtonBelongsToABar(_ button: CGRect, barFrames: [CGRect], windowHeight: CGFloat) -> Bool {
    barFrames.contains { bar in
      button.midX >= bar.minX && button.midX <= bar.maxX
        && button.minY >= bar.minY && button.minY <= bar.minY + windowHeight / 3
    }
  }

  struct NavigationBarSnapshot {
    let frame: CGRect
    /// The bar's identifier, which UIKit sets to the title, or its label when the identifier is empty.
    let title: String
  }

  /// One snapshot per bar. Nil when the read budget ran out before one or one failed.
  func barSnapshots(_ bars: [XCUIElement], deadlineMs: Double) -> [NavigationBarSnapshot]? {
    var snapshots: [NavigationBarSnapshot] = []
    for bar in bars {
      guard currentUptimeMs() < deadlineMs, let snapshot = try? bar.snapshot() else { return nil }
      snapshots.append(
        NavigationBarSnapshot(frame: snapshot.frame, title: snapshot.identifier.isEmpty ? snapshot.label : snapshot.identifier))
    }
    return snapshots
  }

  /// `state` with the bars read: their count, and their titles when a back button has no label.
  static func addingBars(_ bars: [NavigationBarSnapshot], to state: NavigationBarBackState) -> NavigationBarBackState {
    var state = state
    state.barCount = bars.count
    if state.hasUnlabeledBackButton { state.barTitles = bars.map(\.title) }
    return state
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
