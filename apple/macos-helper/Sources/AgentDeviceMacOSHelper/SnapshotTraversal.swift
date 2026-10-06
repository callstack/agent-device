import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

private enum SnapshotTraversalLimits {
  static let maxDesktopApps = 24
  static let maxNodes = 1500
  static let maxDepth = 12
  /// An app session is one app's tree; Electron alone wraps its page in about ten groups.
  static let maxAppDepth = 48
  static let maxMenuBarBandY = 64.0
  static let maxMenuBarBandHeight = 64.0
  static let maxMenuBarExtraWidth = 256.0
}

struct RectResponse: Encodable {
  let x: Double
  let y: Double
  let width: Double
  let height: Double
}

struct SnapshotNodeResponse: Encodable {
  let index: Int
  let type: String?
  let role: String?
  let subrole: String?
  let label: String?
  let value: String?
  let identifier: String?
  let rect: RectResponse?
  let enabled: Bool?
  let selected: Bool?
  let hittable: Bool?
  let depth: Int
  let parentIndex: Int?
  let pid: Int32?
  let bundleId: String?
  let appName: String?
  let windowTitle: String?
  let surface: String?
}

struct SnapshotResponse: Encodable {
  let surface: String
  let nodes: [SnapshotNodeResponse]
  let truncated: Bool
  let backend = "macos-helper"
  let warnings: [String]?
}

private struct SnapshotBuildResult {
  let nodes: [SnapshotNodeResponse]
  let truncated: Bool
  var warnings: [String]? = nil
}

private struct SnapshotContext {
  let surface: String
  let pid: Int32?
  let bundleId: String?
  let appName: String?
  let windowTitle: String?
}

private struct SnapshotTraversalState {
  var nodes: [SnapshotNodeResponse] = []
  var visited: [AXUIElement] = []
  var truncated = false
  /// An element sat at the depth cap with children the walk left out.
  var depthCapped = false
}

private struct MenuBarWindowFallbackCandidate {
  let windowNumber: Int
  let rect: RectResponse
  let layer: Int

  var area: Double {
    rect.width * rect.height
  }
}

func captureSnapshotResponse(surface: String, bundleId: String? = nil) throws -> SnapshotResponse {
  let result: SnapshotBuildResult
  switch surface {
  case "app":
    result = try snapshotSessionApp(bundleId: bundleId)
  case "frontmost-app":
    result = try snapshotFrontmostApp()
  case "desktop":
    result = snapshotDesktop()
  case "menubar":
    result = try snapshotMenuBar(bundleId: bundleId)
  default:
    throw HelperError.invalidArgs("snapshot requires --surface <app|frontmost-app|desktop|menubar>")
  }

  return SnapshotResponse(
    surface: surface, nodes: result.nodes, truncated: result.truncated, warnings: result.warnings)
}

/// The session's own app, whether or not it is frontmost.
private func snapshotSessionApp(bundleId: String?) throws -> SnapshotBuildResult {
  let app = try requireSessionApplication(bundleId: bundleId)
  let webContentReady = enableRemoteAccessibilityTree(app)
  var state = SnapshotTraversalState()
  _ = appendApplicationSnapshot(
    app,
    depth: 0,
    parentIndex: nil,
    surface: "app",
    maxDepth: SnapshotTraversalLimits.maxAppDepth,
    state: &state
  )
  return SnapshotBuildResult(
    nodes: state.nodes,
    truncated: state.truncated || state.depthCapped,
    warnings: webContentReady
      ? nil
      : [
        "The app's Chromium accessibility tree did not populate, so web content may be missing from this snapshot."
      ]
  )
}

/// Chromium and Electron build their accessibility tree only once a client asks for it, so an
/// unannounced reader sees a window of empty groups. Electron answers `AXManualAccessibility`;
/// other Chromium shells answer the VoiceOver-style `AXEnhancedUserInterface`, which native apps
/// also honor by changing window behavior, so it is set only on a Chromium app. The tree stays on
/// for the app's lifetime, as it does for any assistive client.
///
/// Whether the app's web content is readable: true for an app that is not Chromium-based or whose
/// tree is already on. The wait is paid only by the call that turns the tree on.
private func enableRemoteAccessibilityTree(_ app: NSRunningApplication) -> Bool {
  guard isChromiumApplication(app) else { return true }
  let appElement = AXUIElementCreateApplication(app.processIdentifier)
  let attributes = ["AXManualAccessibility", "AXEnhancedUserInterface"]
  if attributes.contains(where: { boolAttribute(appElement, attribute: $0) == true }) {
    return true
  }
  guard
    attributes.contains(where: {
      AXUIElementSetAttributeValue(appElement, $0 as CFString, kCFBooleanTrue) == .success
    })
  else {
    return false
  }
  return awaitPopulatedWebContent(appElement)
}

/// Chromium builds the tree after the request returns, so a walk right after enabling it would see
/// only the wrapper groups. Bounded well inside the helper's own deadline.
private func awaitPopulatedWebContent(_ appElement: AXUIElement) -> Bool {
  let deadline = Date().addingTimeInterval(1.0)
  while !hasPopulatedWebArea(appElement) {
    guard Date() < deadline else { return false }
    Thread.sleep(forTimeInterval: 0.05)
  }
  return true
}

private func hasPopulatedWebArea(_ appElement: AXUIElement) -> Bool {
  var budget = 400
  func visit(_ element: AXUIElement, depth: Int) -> Bool {
    guard budget > 0, depth < 16 else { return false }
    budget -= 1
    let elementChildren = children(of: element)
    if stringAttribute(element, attribute: kAXRoleAttribute as String) == "AXWebArea" {
      return !elementChildren.isEmpty
    }
    return elementChildren.contains { visit($0, depth: depth + 1) }
  }
  return windows(of: appElement).contains { visit($0, depth: 0) }
}

/// Every Chromium embedder, Electron or a renamed framework, ships Chromium's resource pack.
private func isChromiumApplication(_ app: NSRunningApplication) -> Bool {
  guard let frameworksURL = app.bundleURL?.appendingPathComponent("Contents/Frameworks"),
    let frameworks = try? FileManager.default.contentsOfDirectory(atPath: frameworksURL.path)
  else {
    return false
  }
  return frameworks.contains { framework in
    framework.hasSuffix(".framework")
      && FileManager.default.fileExists(
        atPath: frameworksURL.appendingPathComponent(framework)
          .appendingPathComponent("Resources/chrome_100_percent.pak").path
      )
  }
}

private func snapshotFrontmostApp() throws -> SnapshotBuildResult {
  let app = try resolveTargetApplication(bundleId: nil, surface: "frontmost-app")
  var state = SnapshotTraversalState()
  _ = appendApplicationSnapshot(
    app,
    depth: 0,
    parentIndex: nil,
    surface: "frontmost-app",
    state: &state
  )
  return SnapshotBuildResult(nodes: state.nodes, truncated: state.truncated)
}

private func snapshotDesktop() -> SnapshotBuildResult {
  var state = SnapshotTraversalState()
  guard
    let rootIndex = appendSyntheticSnapshotNode(
      into: &state,
      type: "DesktopSurface",
      label: "Desktop",
      depth: 0,
      parentIndex: nil,
      surface: "desktop"
    )
  else {
    return SnapshotBuildResult(nodes: state.nodes, truncated: true)
  }

  var runningApps = NSWorkspace.shared.runningApplications.filter { app in
    app.activationPolicy != .prohibited
      && !app.isTerminated
      && (app.bundleIdentifier?.isEmpty == false || app.localizedName?.isEmpty == false)
  }
  runningApps.sort { left, right in
    if left.isActive != right.isActive {
      return left.isActive && !right.isActive
    }
    return (left.localizedName ?? "") < (right.localizedName ?? "")
  }

  var includedApps = 0
  for app in runningApps {
    if includedApps >= SnapshotTraversalLimits.maxDesktopApps {
      state.truncated = true
      break
    }
    if state.truncated {
      break
    }

    let included = appendApplicationSnapshot(
      app,
      depth: 1,
      parentIndex: rootIndex,
      surface: "desktop",
      state: &state
    )
    if state.truncated {
      break
    }
    if included {
      includedApps += 1
    }
  }

  return SnapshotBuildResult(nodes: state.nodes, truncated: state.truncated)
}

@discardableResult
private func appendApplicationSnapshot(
  _ app: NSRunningApplication,
  depth: Int,
  parentIndex: Int?,
  surface: String,
  maxDepth: Int = SnapshotTraversalLimits.maxDepth,
  state: inout SnapshotTraversalState
) -> Bool {
  let appElement = AXUIElementCreateApplication(app.processIdentifier)
  let visibleWindows = windows(of: appElement).filter(isVisibleSnapshotWindow)
  if visibleWindows.isEmpty {
    return false
  }

  guard
    let appIndex = appendSyntheticSnapshotNode(
      into: &state,
      type: "Application",
      label: app.localizedName ?? app.bundleIdentifier ?? "Application",
      depth: depth,
      parentIndex: parentIndex,
      surface: surface,
      identifier: app.bundleIdentifier,
      pid: Int32(app.processIdentifier),
      bundleId: app.bundleIdentifier,
      appName: app.localizedName
    )
  else {
    return false
  }

  for window in visibleWindows {
    if state.truncated {
      break
    }
    let windowTitle = stringAttribute(window, attribute: kAXTitleAttribute as String)
    _ = appendElementSnapshot(
      window,
      depth: depth + 1,
      parentIndex: appIndex,
      context: SnapshotContext(
        surface: surface,
        pid: Int32(app.processIdentifier),
        bundleId: app.bundleIdentifier,
        appName: app.localizedName,
        windowTitle: windowTitle
      ),
      state: &state,
      maxDepth: maxDepth
    )
  }

  return true
}

private func snapshotMenuBar(bundleId: String?) throws -> SnapshotBuildResult {
  var state = SnapshotTraversalState()
  let screenRect = mainScreenRectResponse()
  guard
    let rootIndex = appendSyntheticSnapshotNode(
      into: &state,
      type: "MenuBarSurface",
      label: "Menu Bar",
      depth: 0,
      parentIndex: nil,
      surface: "menubar",
      rect: screenRect
    )
  else {
    return SnapshotBuildResult(nodes: state.nodes, truncated: true)
  }

  if let bundleId {
    let targetApp = try resolveTargetApplication(bundleId: bundleId, surface: nil)
    let appendedExtras = appendMenuBarSnapshot(
      targetApp,
      attribute: kAXExtrasMenuBarAttribute as String,
      depth: 1,
      parentIndex: rootIndex,
      surface: "menubar",
      state: &state
    )
    if !appendedExtras {
      let appendedMenuBar = appendMenuBarSnapshot(
        targetApp,
        attribute: kAXMenuBarAttribute as String,
        depth: 1,
        parentIndex: rootIndex,
        surface: "menubar",
        state: &state
      )
      if !appendedMenuBar {
        _ = appendMenuBarWindowFallback(
          targetApp,
          depth: 1,
          parentIndex: rootIndex,
          surface: "menubar",
          state: &state
        )
      }
    }
    return SnapshotBuildResult(nodes: state.nodes, truncated: state.truncated)
  }

  if let frontmost = NSWorkspace.shared.frontmostApplication {
    _ = appendMenuBarSnapshot(
      frontmost,
      attribute: kAXMenuBarAttribute as String,
      depth: 1,
      parentIndex: rootIndex,
      surface: "menubar",
      state: &state
    )
  }

  if !state.truncated,
     let systemUiServer = NSRunningApplication.runningApplications(
       withBundleIdentifier: "com.apple.systemuiserver"
     ).first
  {
    let appendedExtras = appendMenuBarSnapshot(
      systemUiServer,
      attribute: kAXExtrasMenuBarAttribute as String,
      depth: 1,
      parentIndex: rootIndex,
      surface: "menubar",
      state: &state,
      windowTitle: "System Menu Extras"
    )
    if !appendedExtras {
      _ = appendMenuBarSnapshot(
        systemUiServer,
        attribute: kAXMenuBarAttribute as String,
        depth: 1,
        parentIndex: rootIndex,
        surface: "menubar",
        state: &state,
        windowTitle: "System Menu Extras"
      )
    }
  }

  return SnapshotBuildResult(nodes: state.nodes, truncated: state.truncated)
}

@discardableResult
private func appendMenuBarSnapshot(
  _ app: NSRunningApplication,
  attribute: String,
  depth: Int,
  parentIndex: Int,
  surface: String,
  state: inout SnapshotTraversalState,
  windowTitle: String? = nil
) -> Bool {
  let appElement = AXUIElementCreateApplication(app.processIdentifier)
  guard let menuBar = elementAttribute(appElement, attribute: attribute) else {
    return false
  }

  let nodeCountBefore = state.nodes.count
  _ = appendElementSnapshot(
    menuBar,
    depth: depth,
    parentIndex: parentIndex,
    context: SnapshotContext(
      surface: surface,
      pid: Int32(app.processIdentifier),
      bundleId: app.bundleIdentifier,
      appName: app.localizedName,
      windowTitle: windowTitle ?? app.localizedName
    ),
    state: &state
  )
  return state.nodes.count > nodeCountBefore
}

@discardableResult
private func appendMenuBarWindowFallback(
  _ app: NSRunningApplication,
  depth: Int,
  parentIndex: Int,
  surface: String,
  state: inout SnapshotTraversalState
) -> Bool {
  guard let candidate = menuBarWindowFallbackCandidate(for: app) else {
    return false
  }

  return appendSyntheticSnapshotNode(
    into: &state,
    type: "MenuBarItem",
    label: app.localizedName ?? app.bundleIdentifier ?? "Menu Bar Item",
    depth: depth,
    parentIndex: parentIndex,
    surface: surface,
    identifier: "cgwindow:\(candidate.windowNumber)",
    pid: Int32(app.processIdentifier),
    bundleId: app.bundleIdentifier,
    appName: app.localizedName,
    windowTitle: app.localizedName,
    rect: candidate.rect,
    hittable: true
  ) != nil
}

@discardableResult
private func appendSyntheticSnapshotNode(
  into state: inout SnapshotTraversalState,
  type: String,
  label: String,
  depth: Int,
  parentIndex: Int?,
  surface: String,
  identifier: String? = nil,
  pid: Int32? = nil,
  bundleId: String? = nil,
  appName: String? = nil,
  windowTitle: String? = nil,
  rect: RectResponse? = nil,
  hittable: Bool = false
) -> Int? {
  guard reserveSnapshotNodeCapacity(&state) else {
    return nil
  }

  let index = state.nodes.count
  state.nodes.append(
    SnapshotNodeResponse(
      index: index,
      type: type,
      role: type,
      subrole: nil,
      label: label,
      value: nil,
      identifier: identifier ?? "surface:\(surface):\(type.lowercased())",
      rect: rect,
      enabled: true,
      selected: nil,
      hittable: hittable && rect != nil,
      depth: depth,
      parentIndex: parentIndex,
      pid: pid,
      bundleId: bundleId,
      appName: appName,
      windowTitle: windowTitle,
      surface: surface
    )
  )
  return index
}

private func mainScreenRectResponse() -> RectResponse? {
  guard let screenFrame = NSScreen.main?.frame, screenFrame.width > 0, screenFrame.height > 0 else {
    return nil
  }
  return RectResponse(
    x: Double(screenFrame.origin.x),
    y: Double(screenFrame.origin.y),
    width: Double(screenFrame.width),
    height: Double(screenFrame.height)
  )
}

private func menuBarWindowFallbackCandidate(
  for app: NSRunningApplication
) -> MenuBarWindowFallbackCandidate? {
  guard
    let windowInfoList = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID)
      as? [[String: Any]]
  else {
    return nil
  }

  let pid = Int(app.processIdentifier)
  let allCandidates = windowInfoList.compactMap { info -> MenuBarWindowFallbackCandidate? in
    let ownerPid = (info[kCGWindowOwnerPID as String] as? NSNumber)?.intValue
    guard ownerPid == pid else {
      return nil
    }
    guard let boundsDictionary = info[kCGWindowBounds as String] as? NSDictionary,
          let bounds = CGRect(dictionaryRepresentation: boundsDictionary)
    else {
      return nil
    }
    guard bounds.width > 0, bounds.height > 0 else {
      return nil
    }
    let alpha = (info[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1
    guard alpha > 0 else {
      return nil
    }
    let rect = RectResponse(
      x: Double(bounds.origin.x),
      y: Double(bounds.origin.y),
      width: Double(bounds.width),
      height: Double(bounds.height)
    )
    let windowNumber = (info[kCGWindowNumber as String] as? NSNumber)?.intValue ?? 0
    let layer = (info[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0
    return MenuBarWindowFallbackCandidate(
      windowNumber: windowNumber,
      rect: rect,
      layer: layer
    )
  }

  // CGWindowList can surface multiple app-owned utility windows. Prefer the small
  // top-band window that matches typical menu bar extra geometry before ranking by area.
  let menuBarBandCandidates = allCandidates.filter { candidate in
    candidate.rect.y <= SnapshotTraversalLimits.maxMenuBarBandY
      && candidate.rect.height <= SnapshotTraversalLimits.maxMenuBarBandHeight
  }
  let narrowCandidates = menuBarBandCandidates.filter { candidate in
    candidate.rect.width <= SnapshotTraversalLimits.maxMenuBarExtraWidth
  }
  let rankedCandidates = (narrowCandidates.isEmpty ? menuBarBandCandidates : narrowCandidates)
    .sorted { left, right in
      if left.area != right.area {
        return left.area < right.area
      }
      if left.layer != right.layer {
        return left.layer < right.layer
      }
      return left.windowNumber < right.windowNumber
    }
  return rankedCandidates.first
}

@discardableResult
private func appendElementSnapshot(
  _ element: AXUIElement,
  depth: Int,
  parentIndex: Int?,
  context: SnapshotContext,
  state: inout SnapshotTraversalState,
  maxDepth: Int = SnapshotTraversalLimits.maxDepth
) -> Int? {
  if state.visited.contains(where: { CFEqual($0, element) }) {
    return parentIndex
  }
  guard reserveSnapshotNodeCapacity(&state) else {
    return parentIndex
  }
  state.visited.append(element)

  let role = stringAttribute(element, attribute: kAXRoleAttribute as String)
  let subrole = stringAttribute(element, attribute: kAXSubroleAttribute as String)
  let title = stringAttribute(element, attribute: kAXTitleAttribute as String)
  let description = stringAttribute(element, attribute: kAXDescriptionAttribute as String)
  let value = stringAttribute(element, attribute: kAXValueAttribute as String)
  let identifier = stringAttribute(element, attribute: "AXIdentifier")
  let rect = rectAttribute(element)
  let enabled = boolAttribute(element, attribute: kAXEnabledAttribute as String)
  let selected = boolAttribute(element, attribute: kAXSelectedAttribute as String)
  let type = normalizedSnapshotType(role: role, subrole: subrole)
  let windowTitle = context.windowTitle ?? inferWindowTitle(for: element)

  let index = state.nodes.count
  state.nodes.append(
    SnapshotNodeResponse(
      index: index,
      type: type,
      role: role,
      subrole: subrole,
      label: title ?? description ?? value,
      value: value,
      identifier: identifier,
      rect: rect,
      enabled: enabled,
      selected: selected,
      hittable: (enabled ?? true) && rect != nil,
      depth: depth,
      parentIndex: parentIndex,
      pid: context.pid,
      bundleId: context.bundleId,
      appName: context.appName,
      windowTitle: windowTitle,
      surface: context.surface
    )
  )

  guard depth < maxDepth, !state.truncated else {
    if depth >= maxDepth, !snapshotChildren(of: element, role: role).isEmpty {
      state.depthCapped = true
    }
    return index
  }

  for child in snapshotChildren(of: element, role: role) {
    if state.truncated {
      break
    }
    _ = appendElementSnapshot(
      child,
      depth: depth + 1,
      parentIndex: index,
      context: SnapshotContext(
        surface: context.surface,
        pid: context.pid,
        bundleId: context.bundleId,
        appName: context.appName,
        windowTitle: windowTitle
      ),
      state: &state,
      maxDepth: maxDepth
    )
  }

  return index
}

private func reserveSnapshotNodeCapacity(_ state: inout SnapshotTraversalState) -> Bool {
  if state.nodes.count >= SnapshotTraversalLimits.maxNodes {
    state.truncated = true
    return false
  }
  return true
}

private func normalizedSnapshotType(role: String?, subrole: String?) -> String? {
  switch role {
  case "AXApplication":
    return "Application"
  case "AXWindow":
    return subrole == "AXStandardWindow" ? "Window" : (subrole ?? "Window")
  case "AXSheet":
    return "Sheet"
  case "AXDialog":
    return "Dialog"
  case "AXButton":
    return "Button"
  case "AXStaticText":
    return "StaticText"
  case "AXTextField":
    return "TextField"
  case "AXTextArea":
    return "TextArea"
  case "AXScrollArea":
    return "ScrollArea"
  case "AXGroup":
    return "Group"
  case "AXMenuBar":
    return "MenuBar"
  case "AXMenuBarItem":
    return "MenuBarItem"
  case "AXMenu":
    return "Menu"
  case "AXMenuItem":
    return "MenuItem"
  default:
    if let subrole, !subrole.isEmpty {
      return subrole
    }
    return role
  }
}

private func isVisibleSnapshotWindow(_ window: AXUIElement) -> Bool {
  guard let rect = rectAttribute(window) else {
    return false
  }
  if rect.width <= 0 || rect.height <= 0 {
    return false
  }
  if boolAttribute(window, attribute: kAXMinimizedAttribute as String) == true {
    return false
  }
  return true
}

private func inferWindowTitle(for element: AXUIElement) -> String? {
  if let title = stringAttribute(element, attribute: kAXTitleAttribute as String) {
    return title
  }
  if let window = elementAttribute(element, attribute: kAXWindowAttribute as String) {
    return stringAttribute(window, attribute: kAXTitleAttribute as String)
  }
  return nil
}

func stringAttribute(_ element: AXUIElement, attribute: String) -> String? {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else {
    return nil
  }
  if let text = value as? String {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }
  return nil
}

func boolAttribute(_ element: AXUIElement, attribute: String) -> Bool? {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success,
        let number = value as? NSNumber
  else {
    return nil
  }
  return number.boolValue
}

func elementAttribute(_ element: AXUIElement, attribute: String) -> AXUIElement? {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success,
        let value,
        CFGetTypeID(value) == AXUIElementGetTypeID()
  else {
    return nil
  }
  return (value as! AXUIElement)
}

func rectAttribute(_ element: AXUIElement) -> RectResponse? {
  var positionValue: CFTypeRef?
  var sizeValue: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &positionValue) == .success,
        AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeValue) == .success,
        let positionAxValue = accessibilityAxValue(positionValue),
        let sizeAxValue = accessibilityAxValue(sizeValue)
  else {
    return nil
  }

  var position = CGPoint.zero
  var size = CGSize.zero
  guard AXValueGetType(positionAxValue) == .cgPoint,
        AXValueGetValue(positionAxValue, .cgPoint, &position),
        AXValueGetType(sizeAxValue) == .cgSize,
        AXValueGetValue(sizeAxValue, .cgSize, &size)
  else {
    return nil
  }

  return RectResponse(
    x: Double(position.x),
    y: Double(position.y),
    width: Double(size.width),
    height: Double(size.height)
  )
}

private func accessibilityAxValue(_ value: CFTypeRef?) -> AXValue? {
  guard let value, CFGetTypeID(value) == AXValueGetTypeID() else {
    return nil
  }
  return (value as! AXValue)
}

private func elementArrayAttribute(_ element: AXUIElement, attribute: String) -> [AXUIElement] {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success,
        let children = value as? [AXUIElement]
  else {
    return []
  }
  return children
}

func children(of element: AXUIElement) -> [AXUIElement] {
  return elementArrayAttribute(element, attribute: kAXChildrenAttribute as String)
}

private func snapshotChildren(of element: AXUIElement, role: String?) -> [AXUIElement] {
  let directChildren = children(of: element)
  if !directChildren.isEmpty {
    return directChildren
  }
  switch role {
  case "AXMenuBar", "AXMenuBarItem", "AXMenu":
    return elementArrayAttribute(element, attribute: kAXVisibleChildrenAttribute as String)
  default:
    return []
  }
}

func windows(of appElement: AXUIElement) -> [AXUIElement] {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(appElement, "AXWindows" as CFString, &value) == .success,
        let windows = value as? [AXUIElement]
  else {
    return []
  }
  return windows
}
