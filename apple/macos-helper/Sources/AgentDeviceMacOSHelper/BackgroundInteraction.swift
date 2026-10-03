import AgentDeviceMacOSInput
import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

/// How an app-surface action reached the app. Every pointer action is an accessibility action on
/// the element under the point: an inactive app drops pointer events posted to its process, so a
/// pointer action with no accessibility equivalent is refused rather than reported as delivered.
enum BackgroundDeliveryMechanism: String, Encodable, CaseIterable {
  case axPress = "ax-press"
  case axFocus = "ax-focus"
  case axValue = "ax-value"
  case axSelectedText = "ax-selected-text"
  case axConfirm = "ax-confirm"
  case axScrollBar = "ax-scroll-bar"
  /// Keyboard events posted to the app's process, which inactive apps do accept.
  case keyEvents = "key-events"
}

/// Typed refusals the host maps to `UNSUPPORTED_OPERATION`. Both vocabularies are pinned by
/// `contracts/fixtures/macos-native-helper-outcomes.json`.
enum BackgroundRefusal: String, CaseIterable {
  case pointerGesture = "background-pointer-gesture"
  case noAccessibleTarget = "no-accessible-target"
  case noTextInput = "no-settable-text-input"
  case noScrollBar = "no-scroll-bar"
}

struct BackgroundPressResponse: Encodable {
  let x: Double
  let y: Double
  let clicks: Int
  let bundleId: String?
  let surface: String
  let mechanism: BackgroundDeliveryMechanism
  let role: String?
  let windowTitle: String?
}

struct BackgroundTextResponse: Encodable {
  let bundleId: String?
  let mechanism: BackgroundDeliveryMechanism
  let role: String?
  let windowTitle: String?
}

struct BackgroundScrollResponse: Encodable {
  let x: Double
  let y: Double
  let x2: Double
  let y2: Double
  let referenceWidth: Double
  let referenceHeight: Double
  let travelPixels: Double
  let mechanism: BackgroundDeliveryMechanism
}

/// Roles whose ancestors are containers, never the control a click meant.
private let pressSearchBoundaryRoles: Set<String> = [
  "AXWindow", "AXApplication", "AXScrollArea", "AXTable", "AXOutline", "AXList", "AXWebArea",
  "AXSheet", "AXDialog",
]
private let textInputRoles: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"]
/// Roles a click means to activate. Chromium marks most wrapper groups pressable too, so a group
/// is only the target when nothing more specific contains the point.
private let pressableControlRoles: Set<String> = [
  "AXButton", "AXLink", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton",
  "AXMenuItem", "AXMenuBarItem", "AXCell", "AXRow", "AXTab", "AXDisclosureTriangle",
  "AXIncrementor", "AXSlider", "AXColorWell", "AXDockItem",
]
private let pressSearchMaxAncestors = 4

func refusal(_ reason: BackgroundRefusal, _ message: String, app: NSRunningApplication) -> HelperError {
  .commandFailed(message, details: ["reason": reason.rawValue, "bundleId": app.bundleIdentifier ?? ""])
}

func requireSessionApplication(bundleId: String?) throws -> NSRunningApplication {
  guard let bundleId, !bundleId.isEmpty else {
    throw HelperError.invalidArgs("the app surface requires --bundle-id <id>")
  }
  return try resolveTargetApplication(bundleId: bundleId, surface: "app")
}

func pressInBackground(
  _ request: MouseClickRequest,
  app: NSRunningApplication
) throws -> BackgroundPressResponse {
  guard !request.doubleClick, request.holdMs <= 0 else {
    throw refusal(
      .pointerGesture,
      "double-click and press-and-hold have no accessibility equivalent in a background app",
      app: app
    )
  }
  let point = CGPoint(x: request.x, y: request.y)
  guard let target = resolvePressTarget(app: app, point: point),
    let mechanism = perform(target)
  else {
    throw refusal(.noAccessibleTarget, "no pressable accessibility element at the point", app: app)
  }
  var clicks = 1
  while clicks < request.clicks {
    Thread.sleep(forTimeInterval: Double(max(request.intervalMs, 0)) / 1000)
    guard perform(target) != nil else { break }
    clicks += 1
  }
  return BackgroundPressResponse(
    x: request.x,
    y: request.y,
    clicks: clicks,
    bundleId: app.bundleIdentifier,
    surface: "app",
    mechanism: mechanism,
    role: role(of: target.element),
    windowTitle: windowTitle(of: target.element)
  )
}

/// Inserts text at the focused element's caret, the way typing does.
func typeInBackground(
  text: String,
  delayMs: Int,
  app: NSRunningApplication
) throws -> BackgroundTextResponse {
  let appElement = AXUIElementCreateApplication(app.processIdentifier)
  let focused = elementAttribute(appElement, attribute: kAXFocusedUIElementAttribute as String)
  let focusedRole = focused.map(role(of:))
  if text == "\n", let focused, actionNames(of: focused).contains(kAXConfirmAction as String),
    AXUIElementPerformAction(focused, kAXConfirmAction as CFString) == .success
  {
    return BackgroundTextResponse(
      bundleId: app.bundleIdentifier, mechanism: .axConfirm, role: focusedRole,
      windowTitle: windowTitle(of: focused))
  }
  if !text.contains("\n"), let focused,
    isAttributeSettable(focused, attribute: kAXSelectedTextAttribute as String),
    AXUIElementSetAttributeValue(focused, kAXSelectedTextAttribute as CFString, text as CFString)
      == .success
  {
    return BackgroundTextResponse(
      bundleId: app.bundleIdentifier, mechanism: .axSelectedText, role: focusedRole,
      windowTitle: windowTitle(of: focused))
  }
  try postText(text, delayMs: delayMs, pid: app.processIdentifier)
  return BackgroundTextResponse(
    bundleId: app.bundleIdentifier, mechanism: .keyEvents, role: focusedRole,
    windowTitle: focused.flatMap(windowTitle(of:)))
}

/// Replaces the value of the text input at a point.
func fillInBackground(
  point: CGPoint,
  text: String,
  app: NSRunningApplication
) throws -> BackgroundTextResponse {
  let hit = elementAtPoint(in: app, point: point)
  let chain = hit.map(pressSearchChain) ?? []
  let fallback = actionWindow(app: app, hit: hit).flatMap { window in
    smallestElement(in: window, containing: point, where: isTextInput)
  }
  guard let input = chain.first(where: isTextInput) ?? fallback,
    isAttributeSettable(input, attribute: kAXValueAttribute as String)
  else {
    throw refusal(.noTextInput, "no settable text input at the point", app: app)
  }
  AXUIElementSetAttributeValue(input, kAXFocusedAttribute as CFString, kCFBooleanTrue)
  guard AXUIElementSetAttributeValue(input, kAXValueAttribute as CFString, text as CFString) == .success
  else {
    throw refusal(.noTextInput, "the text input refused the new value", app: app)
  }
  return BackgroundTextResponse(
    bundleId: app.bundleIdentifier, mechanism: .axValue, role: role(of: input),
    windowTitle: windowTitle(of: input))
}

/// Scrolls the scroll area at the center of the app's front window.
func scrollInBackground(
  direction: String,
  amount: Double?,
  pixels: Double?,
  app: NSRunningApplication
) throws -> BackgroundScrollResponse {
  let isVertical = direction == "up" || direction == "down"
  guard isVertical || direction == "left" || direction == "right" else {
    throw HelperError.invalidArgs("scroll requires --direction <up|down|left|right>")
  }
  guard let frame = frontWindowFrame(pid: app.processIdentifier) else {
    throw HelperError.commandFailed(
      "scroll could not resolve an on-screen window",
      details: ["reason": "window-not-found", "bundleId": app.bundleIdentifier ?? ""]
    )
  }
  let travel = scrollTravelPixels(
    axisLength: Double(isVertical ? frame.height : frame.width),
    amount: amount,
    pixels: pixels
  )
  let center = CGPoint(x: frame.midX, y: frame.midY)
  let revealsLaterContent = direction == "down" || direction == "right"
  guard
    performScrollBarScroll(
      app: app,
      at: center,
      isVertical: isVertical,
      signedTravel: revealsLaterContent ? travel : -travel
    )
  else {
    throw refusal(.noScrollBar, "no scroll area with a settable scroll bar under the window center", app: app)
  }
  // Reported as the equivalent drag, start to end, the way the runner reports a desktop scroll.
  let half = travel / 2
  let sign: Double = revealsLaterContent ? 1 : -1
  return BackgroundScrollResponse(
    x: isVertical ? center.x : center.x + sign * half,
    y: isVertical ? center.y + sign * half : center.y,
    x2: isVertical ? center.x : center.x - sign * half,
    y2: isVertical ? center.y - sign * half : center.y,
    referenceWidth: Double(frame.width),
    referenceHeight: Double(frame.height),
    travelPixels: travel,
    mechanism: .axScrollBar
  )
}

/// Mirrors `runnerScrollGesturePlan`'s travel so both macOS backends scroll the same distance:
/// the requested travel, kept clear of the outer tenth of the axis on both sides.
func scrollTravelPixels(axisLength: Double, amount: Double?, pixels: Double?) -> Double {
  let requested = pixels.map { max(1, $0.rounded()) } ?? (axisLength * (amount ?? 0.6)).rounded()
  let edgePadding = max(1, (axisLength * 0.1).rounded())
  return max(1, min(requested, axisLength - edgePadding * 2))
}

/// The scroll bar value that moves the content by `signedTravel` points, clamped to its ends.
func scrollBarValue(current: Double, signedTravel: Double, overflow: Double) -> Double {
  min(1, max(0, current + signedTravel / overflow))
}

func isPressableControlRole(_ role: String) -> Bool {
  pressableControlRoles.contains(role)
}

private enum PressTarget {
  case focus(AXUIElement)
  case press(AXUIElement)

  var element: AXUIElement {
    switch self {
    case .focus(let element), .press(let element): element
    }
  }
}

/// What a click at a point means. The app's own hit test answers first; web content often answers
/// with a wrapper group, so the snapshot geometry decides when the hit names no control.
private func resolvePressTarget(app: NSRunningApplication, point: CGPoint) -> PressTarget? {
  let hit = elementAtPoint(in: app, point: point)
  let chain = hit.map(pressSearchChain) ?? []
  if let input = chain.first(where: isTextInput) { return .focus(input) }
  if let control = chain.first(where: isPressableControl) { return .press(control) }
  if let found = actionWindow(app: app, hit: hit).flatMap({
    smallestElement(in: $0, containing: point, where: { isTextInput($0) || isPressableControl($0) })
  }) {
    return isTextInput(found) ? .focus(found) : .press(found)
  }
  return chain.first(where: { actionNames(of: $0).contains(kAXPressAction as String) }).map {
    .press($0)
  }
}

private func perform(_ target: PressTarget) -> BackgroundDeliveryMechanism? {
  switch target {
  case .focus(let element):
    return AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
      == .success ? .axFocus : nil
  case .press(let element):
    return AXUIElementPerformAction(element, kAXPressAction as CFString) == .success ? .axPress : nil
  }
}

/// The app's own hit test, scoped to the app so windows of other apps above it do not answer.
private func elementAtPoint(in app: NSRunningApplication, point: CGPoint) -> AXUIElement? {
  let appElement = AXUIElementCreateApplication(app.processIdentifier)
  var hit: AXUIElement?
  guard AXUIElementCopyElementAtPosition(appElement, Float(point.x), Float(point.y), &hit) == .success
  else {
    return nil
  }
  return hit
}

private func pressSearchChain(from hit: AXUIElement) -> [AXUIElement] {
  var chain: [AXUIElement] = []
  var current: AXUIElement? = hit
  while let element = current, chain.count <= pressSearchMaxAncestors {
    if pressSearchBoundaryRoles.contains(role(of: element)) { break }
    chain.append(element)
    current = elementAttribute(element, attribute: kAXParentAttribute as String)
  }
  return chain
}

/// The one window a point action may act in: the window the app's hit test landed in, else the
/// app's front on-screen window. A fallback target never comes from a window behind it, and the
/// response names the window so the host can check it.
private func actionWindow(app: NSRunningApplication, hit: AXUIElement?) -> AXUIElement? {
  if let hit {
    if role(of: hit) == "AXWindow" { return hit }
    if let window = elementAttribute(hit, attribute: kAXWindowAttribute as String) { return window }
  }
  guard let front = frontWindowFrame(pid: app.processIdentifier) else { return nil }
  return windows(of: AXUIElementCreateApplication(app.processIdentifier)).first { window in
    guard let rect = rectAttribute(window) else { return false }
    return abs(rect.x - front.minX) < 1 && abs(rect.y - front.minY) < 1
      && abs(rect.width - front.width) < 1 && abs(rect.height - front.height) < 1
  }
}

private func windowTitle(of element: AXUIElement) -> String? {
  let window = role(of: element) == "AXWindow"
    ? element : elementAttribute(element, attribute: kAXWindowAttribute as String)
  return window.flatMap { stringAttribute($0, attribute: kAXTitleAttribute as String) }
}

/// The smallest matching element in a window whose frame contains the point, skipping subtrees
/// whose frame excludes the point.
private func smallestElement(
  in window: AXUIElement,
  containing point: CGPoint,
  where matches: (AXUIElement) -> Bool
) -> AXUIElement? {
  var best: (element: AXUIElement, area: Double)?
  var budget = 6000
  func visit(_ element: AXUIElement, depth: Int) {
    guard budget > 0, depth < 64 else { return }
    budget -= 1
    if let rect = rectAttribute(element), rect.width > 0, rect.height > 0 {
      guard CGRect(x: rect.x, y: rect.y, width: rect.width, height: rect.height).contains(point)
      else { return }
      let area = rect.width * rect.height
      if area < (best?.area ?? .infinity), matches(element) {
        best = (element, area)
      }
    }
    for child in children(of: element) {
      visit(child, depth: depth + 1)
    }
  }
  visit(window, depth: 0)
  return best?.element
}

/// Moves the scroll bar of the scroll area under a point by the travel's share of the content's
/// overflow. An inactive app honors a scroll bar change where it drops wheel events.
private func performScrollBarScroll(
  app: NSRunningApplication,
  at point: CGPoint,
  isVertical: Bool,
  signedTravel: Double
) -> Bool {
  var current = elementAtPoint(in: app, point: point)
  for _ in 0..<8 {
    guard let element = current, role(of: element) != "AXWindow" else { return false }
    current = elementAttribute(element, attribute: kAXParentAttribute as String)
    guard role(of: element) == "AXScrollArea" else { continue }
    let barAttribute = isVertical ? kAXVerticalScrollBarAttribute : kAXHorizontalScrollBarAttribute
    guard let bar = elementAttribute(element, attribute: barAttribute as String),
      isAttributeSettable(bar, attribute: kAXValueAttribute as String),
      let value = numberAttribute(bar, attribute: kAXValueAttribute as String),
      let area = rectAttribute(element),
      let content = children(of: element)
        .filter({ role(of: $0) != "AXScrollBar" })
        .compactMap(rectAttribute)
        .max(by: { $0.width * $0.height < $1.width * $1.height })
    else {
      continue
    }
    let overflow = isVertical ? content.height - area.height : content.width - area.width
    guard overflow > 0 else { continue }
    let next = scrollBarValue(current: value, signedTravel: signedTravel, overflow: overflow)
    return AXUIElementSetAttributeValue(bar, kAXValueAttribute as CFString, NSNumber(value: next))
      == .success
  }
  return false
}

private func role(of element: AXUIElement) -> String {
  stringAttribute(element, attribute: kAXRoleAttribute as String) ?? ""
}

private func isTextInput(_ element: AXUIElement) -> Bool {
  textInputRoles.contains(role(of: element))
}

private func isPressableControl(_ element: AXUIElement) -> Bool {
  isPressableControlRole(role(of: element))
    && actionNames(of: element).contains(kAXPressAction as String)
}

private func actionNames(of element: AXUIElement) -> [String] {
  var names: CFArray?
  guard AXUIElementCopyActionNames(element, &names) == .success, let names = names as? [String] else {
    return []
  }
  return names
}

private func isAttributeSettable(_ element: AXUIElement, attribute: String) -> Bool {
  var settable = DarwinBoolean(false)
  return AXUIElementIsAttributeSettable(element, attribute as CFString, &settable) == .success
    && settable.boolValue
}

private func numberAttribute(_ element: AXUIElement, attribute: String) -> Double? {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success,
    let number = value as? NSNumber
  else {
    return nil
  }
  return number.doubleValue
}

private struct OnScreenWindow {
  let number: Int
  let bounds: CGRect
}

/// The pid's normal-layer windows, front to back. Bounds and owners need no Screen Recording
/// permission; only titles do.
private func onScreenWindows(pid: pid_t) -> [OnScreenWindow] {
  guard
    let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
      as? [[String: Any]]
  else {
    return []
  }
  return info.compactMap { entry in
    guard (entry[kCGWindowOwnerPID as String] as? Int32) == pid,
      (entry[kCGWindowLayer as String] as? Int) == 0,
      let number = entry[kCGWindowNumber as String] as? Int,
      let boundsDict = entry[kCGWindowBounds as String] as? NSDictionary,
      let bounds = CGRect(dictionaryRepresentation: boundsDict as CFDictionary)
    else {
      return nil
    }
    return OnScreenWindow(number: number, bounds: bounds)
  }
}

func frontWindowNumber(pid: pid_t) -> Int? {
  onScreenWindows(pid: pid).first?.number
}

private func frontWindowFrame(pid: pid_t) -> CGRect? {
  onScreenWindows(pid: pid).first?.bounds
}

private let returnVirtualKey: CGKeyCode = 36
private let tabVirtualKey: CGKeyCode = 48

private func postKey(virtualKey: CGKeyCode, pid: pid_t) throws {
  guard let down = CGEvent(keyboardEventSource: nil, virtualKey: virtualKey, keyDown: true),
    let up = CGEvent(keyboardEventSource: nil, virtualKey: virtualKey, keyDown: false)
  else {
    throw HelperError.commandFailed("key event creation failed", details: ["reason": "event_creation_failed"])
  }
  down.postToPid(pid)
  up.postToPid(pid)
}

private func postText(_ text: String, delayMs: Int, pid: pid_t) throws {
  for character in text {
    switch character {
    case "\n", "\r":
      try postKey(virtualKey: returnVirtualKey, pid: pid)
    case "\t":
      try postKey(virtualKey: tabVirtualKey, pid: pid)
    default:
      guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
        let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
      else {
        throw HelperError.commandFailed(
          "key event creation failed", details: ["reason": "event_creation_failed"])
      }
      let units = Array(String(character).utf16)
      down.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
      up.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
      down.postToPid(pid)
      up.postToPid(pid)
    }
    if delayMs > 0 {
      Thread.sleep(forTimeInterval: Double(delayMs) / 1000)
    }
  }
}
