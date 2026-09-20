import AgentDeviceMacOSDeviceHub
import AppKit
import ApplicationServices
import Darwin
import Foundation

/// The Xcode Device Hub application. Its device windows carry an action bar whose pose controls
/// are the only public seam onto the private channel that folds a simulator.
private let deviceHubBundleId = "com.apple.dt.Devices"

/// How long a reopen gets to restore a window, and a sidebar selection to switch the window's
/// device, before the press is refused.
private let deviceHubSettleDeadline: TimeInterval = 8
private let deviceHubPoll: TimeInterval = 0.25

struct DeviceHubPoseResponse: Encodable {
  let pose: String
  let control: String
  let windowTitle: String
  /** Whether Device Hub had to be asked to reopen a window before the device could be selected. */
  let reopened: Bool
  /** Whether the window was switched to the device through its sidebar row. */
  let selected: Bool
}

func handleDeviceHub(arguments: [String]) throws -> any Encodable {
  guard arguments.first == "pose" else {
    throw HelperError.invalidArgs("device-hub requires pose")
  }
  let rest = Array(arguments.dropFirst())
  guard let udid = helperOptionValue(arguments: rest, name: "--udid")?
    .trimmingCharacters(in: .whitespacesAndNewlines),
    !udid.isEmpty
  else {
    throw HelperError.invalidArgs("device-hub pose requires --udid <udid>")
  }
  guard let deviceName = helperOptionValue(arguments: rest, name: "--device-name")?
    .trimmingCharacters(in: .whitespacesAndNewlines),
    !deviceName.isEmpty
  else {
    throw HelperError.invalidArgs("device-hub pose requires --device-name <name>")
  }
  guard let pose = helperOptionValue(arguments: rest, name: "--pose").flatMap(DeviceHubPose.init(argument:))
  else {
    throw HelperError.invalidArgs("device-hub pose requires --pose <closed|book|open>")
  }
  let control = pose.controlDescription
  guard AXIsProcessTrusted() else {
    throw HelperError.commandFailed(
      "fold needs Accessibility permission to press the Device Hub pose control",
      details: ["reason": "accessibility-permission", "permission": "accessibility"]
    )
  }
  guard let pid = deviceHubProcessIdentifier() else {
    throw HelperError.commandFailed(
      "Xcode Device Hub is not running",
      details: ["reason": "device-hub-not-running", "bundleId": deviceHubBundleId]
    )
  }

  let appElement = AXUIElementCreateApplication(pid)
  let (window, reopened) = try deviceHubWindow(in: appElement, pid: pid, deviceName: deviceName)
  let selected = try selectDevice(udid: udid, deviceName: deviceName, in: window, appElement: appElement)
  let windowTitle = stringAttribute(window, attribute: kAXTitleAttribute as String) ?? ""
  guard let button = awaitPoseButton(in: window, description: control) else {
    throw HelperError.commandFailed(
      "Device Hub shows no \(control) pose control for \(deviceName)",
      details: [
        "reason": "device-hub-pose-control-missing",
        "windowTitle": windowTitle,
        "control": control,
      ]
    )
  }
  let status = AXUIElementPerformAction(button, kAXPressAction as CFString)
  guard status == .success else {
    throw HelperError.commandFailed(
      "Device Hub refused the \(control) pose press",
      details: ["reason": "device-hub-press-failed", "status": "\(status.rawValue)"]
    )
  }
  return SuccessEnvelope(
    data: DeviceHubPoseResponse(
      pose: pose.rawValue,
      control: control,
      windowTitle: windowTitle,
      reopened: reopened,
      selected: selected
    )
  )
}

/// Device Hub is launched through a trampoline, so LaunchServices registers it with no process
/// identifier (`NSRunningApplication.processIdentifier` is -1) and an accessibility element built
/// from that identifier is invalid. The process table is the only place its real pid appears.
private func deviceHubProcessIdentifier() -> pid_t? {
  let executableSuffix = deviceHubExecutableSuffix
  let byteCount = proc_listpids(UInt32(PROC_ALL_PIDS), 0, nil, 0)
  guard byteCount > 0 else { return nil }
  var pids = [pid_t](repeating: 0, count: Int(byteCount) / MemoryLayout<pid_t>.size + 64)
  let filled = proc_listpids(
    UInt32(PROC_ALL_PIDS), 0, &pids, Int32(pids.count * MemoryLayout<pid_t>.size)
  )
  guard filled > 0 else { return nil }
  var path = [CChar](repeating: 0, count: 4096)
  for pid in pids.prefix(Int(filled) / MemoryLayout<pid_t>.size) where pid > 0 {
    guard proc_pidpath(pid, &path, UInt32(path.count)) > 0 else { continue }
    if String(cString: path).hasSuffix(executableSuffix) {
      return pid
    }
  }
  return nil
}

/// A device window to drive: the one already showing this device when there is one, otherwise
/// any device window, since its sidebar can switch it to the device. A Device Hub with no window
/// at all — a simulator booted headlessly leaves it that way — is asked to reopen one.
private func deviceHubWindow(
  in appElement: AXUIElement,
  pid: pid_t,
  deviceName: String
) throws -> (window: AXUIElement, reopened: Bool) {
  if let window = preferredWindow(in: appElement, deviceName: deviceName) {
    return (window, false)
  }
  try sendReopenEvent(to: pid)
  let deadline = Date().addingTimeInterval(deviceHubSettleDeadline)
  while Date() < deadline {
    Thread.sleep(forTimeInterval: deviceHubPoll)
    if let window = preferredWindow(in: appElement, deviceName: deviceName) {
      return (window, true)
    }
  }
  throw HelperError.commandFailed(
    "Device Hub shows no device window to drive",
    details: ["reason": "device-hub-window-missing", "deviceName": deviceName]
  )
}

private func preferredWindow(in appElement: AXUIElement, deviceName: String) -> AXUIElement? {
  let candidates = windows(of: appElement)
  return candidates.first { windowShows(deviceName: deviceName, $0) } ?? candidates.first
}

private func windowShows(deviceName: String, _ window: AXUIElement) -> Bool {
  return deviceHubWindowShows(
    deviceName: deviceName,
    title: stringAttribute(window, attribute: kAXTitleAttribute as String)
  )
}

/// `kAEReopenApplication` is what the Dock sends when an app with no open windows is clicked, and
/// it is the one event Device Hub answers by restoring the device window. Sent to the process
/// directly, because LaunchServices cannot address a trampolined app by bundle identifier.
private func sendReopenEvent(to pid: pid_t) throws {
  let target = NSAppleEventDescriptor(processIdentifier: pid)
  let event = NSAppleEventDescriptor(
    eventClass: AEEventClass(kCoreEventClass),
    eventID: AEEventID(kAEReopenApplication),
    targetDescriptor: target,
    returnID: AEReturnID(kAutoGenerateReturnID),
    transactionID: AETransactionID(kAnyTransactionID)
  )
  do {
    _ = try event.sendEvent(options: [.noReply], timeout: 5)
  } catch {
    let code = (error as NSError).code
    throw HelperError.commandFailed(
      "fold could not ask Device Hub to reopen its device window",
      details: [
        "reason": code == -1743 ? "automation-permission" : "device-hub-reopen-failed",
        "error": String(describing: error),
      ]
    )
  }
}

/// Switches the window to the device through its sidebar row, whose accessibility identifier is
/// `TableRow.Device.<udid>` — the one place Device Hub exposes a device identity that two
/// simulators sharing a name cannot confuse. A window already titled with the device still gets
/// the selection when the row is visible, because the title alone cannot tell such twins apart.
private func selectDevice(
  udid: String,
  deviceName: String,
  in window: AXUIElement,
  appElement: AXUIElement
) throws -> Bool {
  var shownSidebar = false
  var row = deviceRow(udid: udid, in: window)
  if row == nil, showSidebar(appElement: appElement) {
    shownSidebar = true
    let deadline = Date().addingTimeInterval(deviceHubSettleDeadline)
    while row == nil, Date() < deadline {
      Thread.sleep(forTimeInterval: deviceHubPoll)
      row = deviceRow(udid: udid, in: window)
    }
  }
  defer {
    if shownSidebar { _ = pressMenuItem(appElement: appElement, menu: "View", item: "Hide Sidebar") }
  }
  guard let row else {
    if windowShows(deviceName: deviceName, window) {
      return false
    }
    throw HelperError.commandFailed(
      "Device Hub lists no device \(udid) in its sidebar",
      details: ["reason": "device-hub-device-missing", "udid": udid, "deviceName": deviceName]
    )
  }
  let status = AXUIElementSetAttributeValue(row, kAXSelectedAttribute as CFString, kCFBooleanTrue)
  guard status == .success else {
    throw HelperError.commandFailed(
      "Device Hub refused to select \(deviceName) in its sidebar",
      details: ["reason": "device-hub-select-failed", "status": "\(status.rawValue)"]
    )
  }
  let deadline = Date().addingTimeInterval(deviceHubSettleDeadline)
  while !windowShows(deviceName: deviceName, window), Date() < deadline {
    Thread.sleep(forTimeInterval: deviceHubPoll)
  }
  guard windowShows(deviceName: deviceName, window) else {
    throw HelperError.commandFailed(
      "Device Hub did not switch its window to \(deviceName)",
      details: [
        "reason": "device-hub-select-unconfirmed",
        "windowTitle": stringAttribute(window, attribute: kAXTitleAttribute as String) ?? "",
      ]
    )
  }
  return true
}

private func deviceRow(udid: String, in window: AXUIElement) -> AXUIElement? {
  guard let label = findElement(root: window, depth: 0, where: {
    stringAttribute($0, attribute: "AXIdentifier") == deviceHubDeviceRowIdentifier(udid: udid)
  }) else {
    return nil
  }
  var current: AXUIElement? = label
  while let element = current {
    if stringAttribute(element, attribute: kAXRoleAttribute as String) == "AXRow" {
      return element
    }
    current = elementAttribute(element, attribute: kAXParentAttribute as String)
  }
  return nil
}

private func showSidebar(appElement: AXUIElement) -> Bool {
  return pressMenuItem(appElement: appElement, menu: "View", item: "Show Sidebar")
}

private func pressMenuItem(appElement: AXUIElement, menu: String, item: String) -> Bool {
  guard let menuBar = elementAttribute(appElement, attribute: kAXMenuBarAttribute as String) else {
    return false
  }
  for menuBarItem in children(of: menuBar)
  where stringAttribute(menuBarItem, attribute: kAXTitleAttribute as String) == menu {
    for submenu in children(of: menuBarItem) {
      for menuItem in children(of: submenu)
      where stringAttribute(menuItem, attribute: kAXTitleAttribute as String) == item {
        return AXUIElementPerformAction(menuItem, kAXPressAction as CFString) == .success
      }
    }
  }
  return false
}

/// The action bar is rebuilt for the device the window shows, so right after a sidebar selection
/// the window already carries the new title while the pose controls are still being laid out.
/// The controls are therefore awaited, not looked up once.
private func awaitPoseButton(in window: AXUIElement, description: String) -> AXUIElement? {
  let deadline = Date().addingTimeInterval(deviceHubSettleDeadline)
  while true {
    if let button = poseButton(in: window, description: description) {
      return button
    }
    guard Date() < deadline else { return nil }
    Thread.sleep(forTimeInterval: deviceHubPoll)
  }
}

/// The pose controls sit in the window's action bar as `AXButton`s described by their preset
/// name; the simulated screen inside the same window is an iOS content group whose own buttons
/// carry app labels, never these three.
private func poseButton(in window: AXUIElement, description: String) -> AXUIElement? {
  return findElement(root: window, depth: 0) {
    stringAttribute($0, attribute: kAXRoleAttribute as String) == "AXButton"
      && stringAttribute($0, attribute: kAXDescriptionAttribute as String) == description
  }
}

private func findElement(
  root: AXUIElement,
  depth: Int,
  where matches: (AXUIElement) -> Bool
) -> AXUIElement? {
  if depth > 14 {
    return nil
  }
  for child in children(of: root) {
    if matches(child) {
      return child
    }
    if stringAttribute(child, attribute: kAXSubroleAttribute as String) == "iOSContentGroup" {
      continue
    }
    if let nested = findElement(root: child, depth: depth + 1, where: matches) {
      return nested
    }
  }
  return nil
}

func helperOptionValue(arguments: [String], name: String) -> String? {
  guard let index = arguments.firstIndex(of: name), arguments.indices.contains(index + 1) else {
    return nil
  }
  return arguments[index + 1]
}
