import XCTest
import AgentDeviceSnapshotPresentation

#if os(macOS)
import CoreGraphics
#endif

/// A coordinate gesture refused before XCTest could build a coordinate from an app it cannot
/// snapshot. `executeOnMainPrepared` answers it as `UNSUPPORTED_OPERATION` with its hint.
struct RunnerCoordinateRefusal: Error {
  let message: String
  let hint: String?
}

private struct RunnerUnsupportedOperationError: LocalizedError {
  let message: String

  var errorDescription: String? { message }
}

extension RunnerTests {
  enum PlannedGestureExecution: Equatable {
    case fastSwipe
    case sampled
  }

  enum SynthesizedDragProfile: Equatable {
    case controlledScroll
    case fastSwipe
  }

  func scrollDragProfile(
    releaseBehavior: ScrollReleaseBehavior?
  ) -> SynthesizedDragProfile {
    releaseBehavior == .inertial ? .fastSwipe : .controlledScroll
  }

  struct TouchVisualizationFrame {
    let x: Double
    let y: Double
    let referenceWidth: Double
    let referenceHeight: Double
  }

  struct DragVisualizationFrame {
    let x: Double
    let y: Double
    let x2: Double
    let y2: Double
    let referenceWidth: Double
    let referenceHeight: Double
  }

  struct DragPoints {
    let x: Double
    let y: Double
    let x2: Double
    let y2: Double
  }

  struct SynthesizedDragPlan {
    let points: DragPoints
    let context: SynthesizedCoordinateContext

  }

  struct SelectorElementMatch {
    let element: XCUIElement?
    let isAmbiguous: Bool
    let usedNonHittableFallback: Bool
  }

  func performBackGesture(app: XCUIApplication) throws {
    if pressTvRemote(.menu) {
      return
    }
    try performCoordinateBackGesture(app: app)
  }

  private func performCoordinateBackGesture(app: XCUIApplication) throws {
#if !os(tvOS)
    let target = try normalizedOffsetAnchor(app: app)
    let start = target.coordinate(withNormalizedOffset: CGVector(dx: 0.05, dy: 0.5))
    let end = target.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.5))
    start.press(forDuration: 0.05, thenDragTo: end)
#endif
  }

  func performSystemBackAction(app: XCUIApplication) throws -> Bool {
#if os(macOS)
    return false
#else
    if pressTvRemote(.menu) {
      return true
    }
    try performBackGesture(app: app)
    return true
#endif
  }

  func performAppSwitcherGesture(app: XCUIApplication) throws {
    if pressTvRemote(.home) {
      sleepFor(resolveTvRemoteDoublePressDelay())
      _ = pressTvRemote(.home)
      return
    }
    try performCoordinateAppSwitcherGesture(app: app)
  }

  private func performCoordinateAppSwitcherGesture(app: XCUIApplication) throws {
#if !os(tvOS)
    let target = try normalizedOffsetAnchor(app: app)
    let start = target.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.99))
    let end = target.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.7))
    start.press(forDuration: 0.6, thenDragTo: end)
#endif
  }

  func pressHomeButton() {
#if os(macOS)
    return
#else
    if pressTvRemote(.home) {
      return
    }
    XCUIDevice.shared.press(.home)
#endif
  }

  /// Presses the iPhone Action Button, returning false when this device cannot express the press.
  ///
  /// `XCUIDevice.press(_:)` has no hold-duration overload, so a single press is the whole gesture
  /// this API can express. `hasHardwareButton(.action)` is what separates a model with the button
  /// from one without, and both it and `Button.action` need iOS 16 while the deployment target is
  /// lower, so an older system refuses rather than pressing a control that cannot exist there.
  @discardableResult
  func pressActionButton() -> Bool {
#if os(iOS)
    guard #available(iOS 16.0, *) else { return false }
    guard XCUIDevice.shared.hasHardwareButton(.action) else { return false }
    XCUIDevice.shared.press(.action)
    return true
#else
    return false
#endif
  }

  /// Presses a physical volume key once, returning false when this target cannot express the press.
  ///
  /// `XCUIDevice.press(_:)` declares `.volumeUp` and `.volumeDown` unavailable to simulator
  /// builds (`XCUI_SIMULATOR_UNAVAILABLE` in the XCUITest header), so the press compiles only for
  /// a physical-device build; a simulator target refuses rather than pressing a control that
  /// does not exist there. Every iPhone and iPad carries a volume key, so no per-model probe is
  /// needed the way the Action Button needs `hasHardwareButton(.action)`.
  @discardableResult
  func pressVolumeButton(_ button: CommandType) -> Bool {
#if os(iOS) && !targetEnvironment(simulator)
    switch button {
    case .volumeUp:
      XCUIDevice.shared.press(.volumeUp)
      return true
    case .volumeDown:
      XCUIDevice.shared.press(.volumeDown)
      return true
    default:
      return false
    }
#else
    return false
#endif
  }

  func findElement(app: XCUIApplication, text: String) throws -> XCUIElement? {
    let predicate = NSPredicate(format: "label CONTAINS[c] %@ OR identifier CONTAINS[c] %@ OR value CONTAINS[c] %@", text, text, text)
    return try elementQueries(app: app, matching: .any)
      .lazy
      .map { $0.matching(predicate).firstMatch }
      .first { $0.exists }
  }

  func findElement(
    app: XCUIApplication,
    selectorKey: String,
    selectorValue: String,
    allowNonHittableFallback: Bool = false,
    expectedPoint: CGPoint? = nil,
    rawMatchPolicy: DirectSelectorRawMatchPolicy = .rejectDistinctMatches
  ) throws -> SelectorElementMatch {
    let value = selectorValue.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !value.isEmpty else {
      return SelectorElementMatch(element: nil, isAmbiguous: false, usedNonHittableFallback: false)
    }
    let predicate: NSPredicate
    switch selectorKey {
    case "id":
      predicate = NSPredicate(format: "identifier ==[c] %@", value)
    case "label":
      predicate = NSPredicate(format: "label ==[c] %@", value)
    case "value":
      predicate = NSPredicate(format: "value ==[c] %@", value)
    case "text":
      predicate = NSPredicate(format: "label ==[c] %@ OR identifier ==[c] %@ OR value ==[c] %@", value, value, value)
    default:
      return SelectorElementMatch(element: nil, isAmbiguous: false, usedNonHittableFallback: false)
    }

    let matches = try elementQueries(app: app, matching: .any)
      .flatMap { $0.matching(predicate).allElementsBoundByIndex }
      .filter(\.exists)
    let facts = try matches.map { element in
      let isHittable = element.isHittable
      let containsExpectedPoint = expectedPoint.map(element.frame.contains) ?? true
      return SelectorCandidateFacts(
        isHittable: isHittable,
        hasTappableFrame: allowNonHittableFallback && !isHittable && containsExpectedPoint
          ? try hasTappableFrame(app: app, element: element) : false,
        containsExpectedPoint: containsExpectedPoint
      )
    }
    switch classifyDirectSelectorCandidates(
      facts,
      allowNonHittableFallback: allowNonHittableFallback,
      filtersByExpectedPoint: expectedPoint != nil,
      rawMatchPolicy: rawMatchPolicy
    ) {
    case .noMatch:
      return SelectorElementMatch(element: nil, isAmbiguous: false, usedNonHittableFallback: false)
    case .ambiguous:
      return SelectorElementMatch(element: nil, isAmbiguous: true, usedNonHittableFallback: false)
    case let .selected(index, usedNonHittableFallback):
      return SelectorElementMatch(
        element: matches[index],
        isAmbiguous: false,
        usedNonHittableFallback: usedNonHittableFallback
      )
    }
  }

  // Maestro-compat gate for the non-hittable coordinate fallback: an element
  // with no frame at all cannot be coordinate-tapped, otherwise the decision
  // is the shared TapPointPolicy center-in-frame rule (golden parity table
  // with the TS twin). app.frame is the frame source here — replay taps
  // resolved bounds Maestro-style, so the union frame is intentional. A
  // lit-panel request uses its booked window, because app.frame names one
  // panel (ADR 0025).
  private func hasTappableFrame(app: XCUIApplication, element: XCUIElement) throws -> Bool {
    let windowFrame = try requestLitPanel == nil
      ? readableAppFrame(app: app)
      : requireRequestLitPanelSurface(app: app).geometry.windowOnScreen.rect
    let frame = element.frame
    if frame.isEmpty {
      return false
    }
    return TapPointPolicy.isAllowed(elementFrame: frame, windowFrame: windowFrame)
  }

  // The tappable on-screen viewport. app.frame is unsuitable: it unions
  // transformed subtrees, so a closed drawer at negative x inflates it and
  // out-of-window coordinates still pass containment. Falls back to app.frame
  // when no window frame is readable.
  /// The app window interactions and captures are booked against: the first window the app
  /// reports with a non-empty frame, and no window at all when none qualifies. The viewport,
  /// the interaction anchor, and the synthesized reference frame all resolve through here, so a
  /// fold, a sheet, or a rotation moves every consumer to the same window in the same pass.
  /// Synthesized gestures route their display ID through the returned window so the record's
  /// display can never name a different window than the one the reference frame was measured on.
  ///
  /// Stops at the first qualifying window. Reading a window that will be discarded is not free: a
  /// transient candidate that disappears between its `exists` answer and its `frame` fetch makes
  /// XCTest record an issue, and an issue `record(_:)` does not mute ends the runner session
  /// (ADR 0004, ADR 0005, #2995).
  ///
  /// The read that remains is not atomic: a window vanishing while it is the one being resolved still
  /// records, and the chosen window is read again on its way to a display ID
  /// (`RunnerResolveWindowDisplayID`).
  ///
  /// Without a window the frame is the app's own, from the held `heldAppFrame` read, and empty when
  /// that does not read either. A coordinate gesture resolves through `resolveCoordinateWindow`
  /// instead, which refuses there.
  func resolveRunnerWindow(app: XCUIApplication) throws -> (window: XCUIElement?, frame: CGRect) {
    try resolveRunnerWindow(app: app) { heldAppFrame(app: $0) ?? .zero }
  }

  /// `resolveRunnerWindow` for a coordinate gesture: without a window it reads the app frame through
  /// `readableAppFrame`, so a tree that answers neither refuses the gesture.
  func resolveCoordinateWindow(app: XCUIApplication) throws -> (window: XCUIElement?, frame: CGRect) {
    try resolveRunnerWindow(app: app, appFrame: readableAppFrame)
  }

  private func resolveRunnerWindow(
    app: XCUIApplication,
    appFrame: (XCUIApplication) throws -> CGRect
  ) throws -> (window: XCUIElement?, frame: CGRect) {
    if requestLitPanel != nil {
      let booked = try requireRequestLitPanelSurface(app: app)
      return (booked.window, booked.geometry.windowOnScreen.rect)
    }
    guard let resolved = resolveRunnerWindowElement(app: app) else { return (nil, try appFrame(app)) }
    return (resolved.window, resolved.frame)
  }

  /// The app's own frame, or nil where it does not read. On iOS the read is held inside an issue
  /// scope: on a tree XCTest cannot snapshot it fails after its retries, and an unheld issue ends the
  /// runner test. A read that records an issue or leaves a non-finite frame (the infinite point XCTest
  /// would anchor on) is nil; a finite empty frame reads. Every iOS read of the app frame goes through
  /// here.
  func heldAppFrame(app: XCUIApplication) -> CGRect? {
#if os(iOS)
    var frame = CGRect.null
    let held = holdingRecordedIssues { frame = app.frame }
    let finite = !frame.isNull && !frame.isInfinite
      && frame.minX.isFinite && frame.minY.isFinite && frame.maxX.isFinite && frame.maxY.isFinite
    guard held.issues.isEmpty, held.exceptionMessage == nil, finite else { return nil }
    return frame
#else
    return app.frame
#endif
  }

  /// The app frame a coordinate gesture decides on: `heldAppFrame`, refusing with the coded
  /// `RunnerCoordinateRefusal` where it does not read.
  func readableAppFrame(app: XCUIApplication) throws -> CGRect {
#if os(iOS)
    guard let frame = heldAppFrame(app: app) else { throw unreadableTreeRefusal }
    return frame
#else
    return app.frame
#endif
  }

  /// The app's first window with a usable frame, or nil. Unlike `resolveRunnerWindow` it never falls
  /// back to `app.frame`: when the windows query fails because XCTest cannot serialize the app's
  /// tree, that read fails the same way after XCTest's own retries (about 2s on Bluesky's feed).
  func resolveRunnerWindowElement(app: XCUIApplication) -> (window: XCUIElement, frame: CGRect)? {
    if requestLitPanel != nil {
      guard bookRequestLitPanelSurface(app: app) == nil, let booked = litPanelState.surface else { return nil }
      return (booked.window, booked.geometry.windowOnScreen.rect)
    }
    for window in app.windows.allElementsBoundByIndex where window.exists {
      let frame = window.frame
      if !frame.isEmpty {
        return (window, frame)
      }
    }
    return nil
  }

  func onScreenWindowFrame(app: XCUIApplication) throws -> CGRect {
    try resolveRunnerWindow(app: app).frame
  }

  func queryElement(app: XCUIApplication, selectorKey: String, selectorValue: String) throws -> Response {
    // querySelector is a read — it backs get/is/wait and the offscreen-refusal
    // double-check, none of which mutate. The fail-closed raw-match rule exists
    // to stop a mutation acting on an unseen duplicate; applying it here would
    // instead turn a decorative non-hittable duplicate into an AMBIGUOUS_MATCH
    // for readers that previously resolved the hittable element.
    let match = try findElement(
      app: app,
      selectorKey: selectorKey,
      selectorValue: selectorValue,
      rawMatchPolicy: .preferHittableMatch
    )
    if match.isAmbiguous {
      return Response(ok: false, error: ErrorPayload(code: "AMBIGUOUS_MATCH", message: "selector matched multiple elements"))
    }
    guard let element = match.element else {
      return Response(ok: true, data: DataPayload(found: false, nodes: []))
    }

    let label = element.label.trimmingCharacters(in: .whitespacesAndNewlines)
    let identifier = element.identifier.trimmingCharacters(in: .whitespacesAndNewlines)
    let valueText = String(describing: element.value ?? "")
      .trimmingCharacters(in: .whitespacesAndNewlines)
    let node = SnapshotPresentation.singleElementRead(
      RawAXNode(
        index: 0,
        type: elementTypeName(element.elementType),
        label: label.isEmpty ? nil : label,
        identifier: identifier.isEmpty ? nil : identifier,
        value: valueText.isEmpty ? nil : valueText,
        rect: SnapshotRect(element.frame),
        enabled: element.isEnabled,
        focused: nil,
        selected: element.isSelected ? true : nil,
        hittable: element.isHittable,
        depth: 0,
        parentIndex: nil,
        hiddenContentAbove: nil,
        hiddenContentBelow: nil
      )
    )
    return Response(
      ok: true,
      data: DataPayload(
        text: readableText(for: element),
        found: true,
        nodes: [node]
      )
    )
  }

  /// Shared ordering for point-hit candidates: smallest area wins, then top-to-bottom,
  /// left-to-right, then stable element-type order for ties.
  func smallestElementFirst(_ left: any XCUIElementAttributes, _ right: any XCUIElementAttributes) -> Bool {
    let leftArea = max(1, left.frame.width * left.frame.height)
    let rightArea = max(1, right.frame.width * right.frame.height)
    if leftArea != rightArea {
      return leftArea < rightArea
    }
    if left.frame.minY != right.frame.minY {
      return left.frame.minY < right.frame.minY
    }
    if left.frame.minX != right.frame.minX {
      return left.frame.minX < right.frame.minX
    }
    return left.elementType.rawValue < right.elementType.rawValue
  }

  func readTextAt(app: XCUIApplication, x: Double, y: Double) throws -> String? {
    let point = CGPoint(x: x, y: y)
    let textInputCandidates = try textInputCandidatesAt(app: app, point: point, contentTranslation: liveContentTranslation(app: app))
      .map(\.element)
    for element in textInputCandidates where prefersExpandedTextRead(element) {
      if let text = readableText(for: element) {
        return text
      }
    }

    let candidates = try elementQueries(app: app, matching: .any)
      .flatMap { $0.allElementsBoundByIndex }
      .filter { element in
        element.exists && !element.frame.isEmpty && element.frame.contains(point)
      }
      .sorted { smallestElementFirst($0, $1) }

    for element in candidates where prefersExpandedTextRead(element) {
      if let text = readableText(for: element) {
        return text
      }
    }
    for element in candidates {
      if let text = readableText(for: element) {
        return text
      }
    }
    return nil
  }

  private func readableText(for element: XCUIElement) -> String? {
    let label = element.label.trimmingCharacters(in: .whitespacesAndNewlines)
    let identifier = element.identifier.trimmingCharacters(in: .whitespacesAndNewlines)
    let valueText = String(describing: element.value ?? "")
      .trimmingCharacters(in: .whitespacesAndNewlines)
    switch element.elementType {
    case .textField, .secureTextField, .searchField, .textView:
      if !valueText.isEmpty { return valueText }
      if !label.isEmpty { return label }
      return identifier.isEmpty ? nil : identifier
    default:
      if !label.isEmpty { return label }
      if !valueText.isEmpty { return valueText }
      return identifier.isEmpty ? nil : identifier
    }
  }

  private func prefersExpandedTextRead(_ element: XCUIElement) -> Bool {
    switch element.elementType {
    case .textField, .secureTextField, .searchField, .textView:
      return true
    default:
      return false
    }
  }

  /// `context` is this call's own windows read when the caller already holds one, so a command
  /// reads the tree's window once.
  func tapAt(
    app: XCUIApplication,
    x: Double,
    y: Double,
    context: SynthesizedCoordinateContext? = nil
  ) throws -> RunnerInteractionOutcome {
    if let outcome = selectFocusedTvElement(app: app, point: CGPoint(x: x, y: y), action: "tap") {
      return outcome
    }
#if os(iOS)
    return try runOnMainActor({ try tapAtScreenPoint(app: app, x: x, y: y, context: context) }).get()
#else
    return try performCoordinateTap(app: app, x: x, y: y)
#endif
  }

#if os(iOS)
  /// An XCTest coordinate resolves its anchor through the application's accessibility snapshot.
  /// On a tree XCTest cannot serialize (a deep React Native screen) that read fails, XCTest records
  /// an issue that ends the runner test, and the infinite point it leaves raises an exception.
  /// This call's own windows read decides: a tree that answers takes the XCTest coordinate tap,
  /// one that does not is synthesized at the screen point, and a synthesis that cannot run throws
  /// instead of reaching the XCTest coordinate.
  @MainActor
  private func tapAtScreenPoint(
    app: XCUIApplication,
    x: Double,
    y: Double,
    context: SynthesizedCoordinateContext?
  ) throws -> RunnerInteractionOutcome {
    guard let context = try context ?? synthesizedCoordinateContext(app: app) else {
      // No window and no sole screen: the tree is unreadable only when the app's own frame is too.
      _ = try readableAppFrame(app: app)
      return try performCoordinateTap(app: app, x: x, y: y, treeProven: true)
    }
    guard context.treeUnreadable else {
      return try performCoordinateTap(app: app, x: x, y: y, treeProven: true)
    }
    switch try performSynthesizedTapGesture(app: app, x: x, y: y, context: context) {
    case .performed:
      return .performed
    case .xctestFallback(let message, let hint), .refused(_, let message, let hint):
      throw RunnerCoordinateRefusal(message: message, hint: hint)
    }
  }

  var unreadableTreeRefusal: RunnerCoordinateRefusal {
    RunnerCoordinateRefusal(
      message: "XCTest cannot anchor a coordinate gesture: the app's accessibility tree answered no window and no frame",
      hint: "XCTest cannot snapshot this app's accessibility tree, so the runner dispatched nothing. Retry on a shallower screen, or run snapshot -i and act on a ref once its capture reads back."
    )
  }

  /// The element an XCTest coordinate gesture anchors on: the resolved window, or the app itself
  /// where no window answers but the app's own frame does. When neither reads, the tree is
  /// unreadable and the gesture refuses. Every iOS XCUICoordinate that does not come with a proven
  /// tree resolves through here, and the app frame reads only through `readableAppFrame`.
  private func requireReadableTreeAnchor(app: XCUIApplication) throws -> XCUIElement {
    if requestLitPanel != nil {
      return try requireRequestLitPanelSurface(app: app).window
    }
    if let resolved = resolveRunnerWindowElement(app: app) {
      return resolved.window
    }
    _ = try readableAppFrame(app: app)
    return app
  }
#endif

  func mouseClickAt(app: XCUIApplication, x: Double, y: Double, button: String) throws {
#if os(macOS)
    let coordinate = try interactionCoordinate(app: app, x: x, y: y)
    switch button {
    case "primary":
      coordinate.tap()
    case "secondary":
      coordinate.rightClick()
    case "middle":
      throw RunnerUnsupportedOperationError(message: "middle mouse button is not supported")
    default:
      throw RunnerUnsupportedOperationError(message: "unsupported mouse button: \(button)")
    }
#elseif os(tvOS)
    throw RunnerUnsupportedOperationError(message: "mouseClick is not supported on tvOS")
#else
    throw RunnerUnsupportedOperationError(message: "mouseClick is only supported on macOS")
#endif
  }

  func desktopScrollAt(
    app: XCUIApplication,
    x: Double,
    y: Double,
    direction: RunnerScrollDirection,
    pixels: Double,
    durationMs: Double?
  ) throws {
#if os(macOS)
    let events = desktopScrollWheelDeltaEvents(
      direction: direction,
      pixels: pixels,
      durationMs: durationMs
    )

    let coordinate = try interactionCoordinate(app: app, x: x, y: y)
    let interval = desktopScrollEventIntervalSeconds(durationMs: durationMs, eventCount: events.count)
    for (index, deltas) in events.enumerated() {
      // Keep desktop scrolling on XCTest's coordinate API so macOS owns wheel synthesis, natural
      // scrolling preference handling, and cursor placement instead of posting raw CGEvents.
      coordinate.scroll(
        byDeltaX: CGFloat(deltas.horizontal),
        deltaY: CGFloat(deltas.vertical)
      )
      if interval > 0 && index < events.count - 1 {
        Thread.sleep(forTimeInterval: interval)
      }
    }
#elseif os(tvOS)
    throw RunnerUnsupportedOperationError(message: "desktopScroll is not supported on tvOS")
#else
    throw RunnerUnsupportedOperationError(message: "desktopScroll is only supported on macOS")
#endif
  }

  func desktopScrollWheelDeltas(
    direction: RunnerScrollDirection,
    pixels: Double
  ) -> (vertical: Int32, horizontal: Int32) {
    let magnitude = Int32(max(1, min(Double(Int32.max), pixels.rounded())))
    switch direction {
    case .up:
      return (vertical: magnitude, horizontal: 0)
    case .down:
      return (vertical: -magnitude, horizontal: 0)
    case .left:
      return (vertical: 0, horizontal: magnitude)
    case .right:
      return (vertical: 0, horizontal: -magnitude)
    }
  }

  func desktopScrollWheelDeltaEvents(
    direction: RunnerScrollDirection,
    pixels: Double,
    durationMs: Double?
  ) -> [(vertical: Int32, horizontal: Int32)] {
    let totalDeltas = desktopScrollWheelDeltas(direction: direction, pixels: pixels)
    let magnitude = max(abs(Int(totalDeltas.vertical)), abs(Int(totalDeltas.horizontal)))
    let duration = max(0, durationMs ?? 0)
    let requestedEventCount = duration > 0 ? Int(ceil(duration / 16.0)) : 1
    let eventCount = max(1, min(magnitude, requestedEventCount))
    guard eventCount > 1 else {
      return [totalDeltas]
    }

    if totalDeltas.vertical != 0 {
      return distributeDesktopScrollDelta(totalDeltas.vertical, eventCount: eventCount)
        .map { (vertical: $0, horizontal: 0) }
    }
    return distributeDesktopScrollDelta(totalDeltas.horizontal, eventCount: eventCount)
      .map { (vertical: 0, horizontal: $0) }
  }

  func desktopScrollEventIntervalSeconds(durationMs: Double?, eventCount: Int) -> TimeInterval {
    guard let durationMs, durationMs > 0, eventCount > 1 else { return 0 }
    return (durationMs / 1000.0) / Double(eventCount - 1)
  }

  private func distributeDesktopScrollDelta(_ delta: Int32, eventCount: Int) -> [Int32] {
    let sign: Int32 = delta < 0 ? -1 : 1
    let magnitude = abs(Int(delta))
    let base = magnitude / eventCount
    let remainder = magnitude % eventCount
    return (0..<eventCount).map { index in
      sign * Int32(base + (index < remainder ? 1 : 0))
    }
  }

  func doubleTapAt(app: XCUIApplication, x: Double, y: Double) throws -> RunnerInteractionOutcome {
    if let outcome = selectFocusedTvElement(app: app, point: CGPoint(x: x, y: y), action: "double tap") {
      guard case .performed = outcome else { return outcome }
      sleepFor(0.1)
      _ = pressTvRemote(.select)
      return .performed
    }
    return try performCoordinateDoubleTap(app: app, x: x, y: y)
  }

  func longPressAt(app: XCUIApplication, x: Double, y: Double, duration: TimeInterval) throws -> RunnerInteractionOutcome {
    if let outcome = longSelectFocusedTvElement(app: app, point: CGPoint(x: x, y: y), duration: duration) {
      return outcome
    }
    return try performCoordinateLongPress(app: app, x: x, y: y, duration: duration)
  }

  func dragAt(
    app: XCUIApplication,
    x: Double,
    y: Double,
    x2: Double,
    y2: Double,
    holdDuration: TimeInterval
  ) throws -> RunnerInteractionOutcome {
    // tvOS has no coordinate drag. Preserve the direction as a focus move.
    let dx = x2 - x
    let dy = y2 - y
    let button: TvRemoteButton = abs(dx) > abs(dy)
      ? (dx > 0 ? .right : .left)
      : (dy > 0 ? .down : .up)
    if pressTvRemote(button) {
      return .performed
    }
    return try performCoordinateDrag(app: app, x: x, y: y, x2: x2, y2: y2, holdDuration: holdDuration)
  }

  private func performCoordinateTap(
    app: XCUIApplication,
    x: Double,
    y: Double,
    treeProven: Bool = false
  ) throws -> RunnerInteractionOutcome {
#if os(tvOS)
    return .unsupported(
      message: "coordinate tap is not supported on tvOS; move focus with swipe or scroll, then select the focused element",
      hint: "tvOS has no coordinate input; move focus with swipe/scroll to the target, then select it."
    )
#else
    try interactionCoordinate(app: app, x: x, y: y, treeProven: treeProven).tap()
    return .performed
#endif
  }

  private func performCoordinateDoubleTap(app: XCUIApplication, x: Double, y: Double) throws -> RunnerInteractionOutcome {
#if os(tvOS)
    return .unsupported(
      message: "coordinate double tap is not supported on tvOS; move focus with swipe or scroll, then select the focused element",
      hint: "tvOS has no coordinate input; move focus with swipe/scroll to the target, then select it."
    )
#else
    try interactionCoordinate(app: app, x: x, y: y).doubleTap()
    return .performed
#endif
  }

  private func performCoordinateLongPress(app: XCUIApplication, x: Double, y: Double, duration: TimeInterval) throws -> RunnerInteractionOutcome {
#if os(tvOS)
    return .unsupported(
      message: "coordinate long press is not supported on tvOS; move focus with swipe or scroll, then long-select the focused element",
      hint: "tvOS has no coordinate input; move focus with swipe/scroll to the target, then long-select it."
    )
#else
    try interactionCoordinate(app: app, x: x, y: y).press(forDuration: duration)
    return .performed
#endif
  }

  private func performCoordinateDrag(
    app: XCUIApplication,
    x: Double,
    y: Double,
    x2: Double,
    y2: Double,
    holdDuration: TimeInterval
  ) throws -> RunnerInteractionOutcome {
#if os(tvOS)
    return .unsupported(
      message: "coordinate drag is not supported on tvOS",
      hint: "tvOS has no coordinate input; use remote-driven swipe/scroll to move focus instead."
    )
#else
    let start = try interactionCoordinate(app: app, x: x, y: y)
    let end = try interactionCoordinate(app: app, x: x2, y: y2, treeProven: true)
    start.press(forDuration: holdDuration, thenDragTo: end)
    return .performed
#endif
  }

#if !os(tvOS)
  /// The element a normalized-offset XCTest gesture anchors on: the resolved window, which on iOS
  /// must come from a tree that answers.
  private func normalizedOffsetAnchor(app: XCUIApplication) throws -> XCUIElement {
#if os(iOS)
    return try requireReadableTreeAnchor(app: app)
#else
    return try resolveCoordinateWindow(app: app).window ?? app
#endif
  }

  /// `treeProven` is set by a caller whose own windows read already showed the tree answers.
  private func interactionCoordinate(
    app: XCUIApplication,
    x: Double,
    y: Double,
    treeProven: Bool = false
  ) throws -> XCUICoordinate {
#if os(iOS)
    if !treeProven {
      _ = try requireReadableTreeAnchor(app: app)
    }
    // Coordinate taps, double taps, long presses, and drags anchor at the app origin, not the
    // resolved window: callers pass screen points, and `app.frame` starts at the screen origin even
    // for a placed iPad window (#3899). The first qualifying
    // window is not always the one under the finger — a SpringBoard `alert accept` can live in an
    // alert window while the wallpaper or status-bar window qualifies first, so a window-relative
    // anchor misses the button. Reference frames and the synthesized display ID still resolve
    // through `resolveRunnerWindow`. A foldable anchors at the lit panel's window instead, because
    // the app origin names the outer panel whichever one is lit.
    if requestLitPanel == nil {
      let origin = app.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0))
      return origin.withOffset(CGVector(dx: x, dy: y))
    }
    let booked = try requireRequestLitPanelSurface(app: app)
    let origin = booked.window.coordinate(withNormalizedOffset: .zero)
    let point = booked.geometry.contentPoint(from: SurfacePoint(CGPoint(x: x, y: y))).point
    return origin.withOffset(CGVector(dx: point.x, dy: point.y))
#else
    let resolved = try resolveCoordinateWindow(app: app)
    let root = resolved.window ?? app
    let origin = root.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0))
    let offsetX = x - Double(resolved.frame.origin.x)
    let offsetY = y - Double(resolved.frame.origin.y)
    return origin.withOffset(CGVector(dx: offsetX, dy: offsetY))
#endif
  }
#endif
}
