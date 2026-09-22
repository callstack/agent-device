import AgentDeviceMacOSDeviceHub
import AppKit
import ApplicationServices
import Darwin
import Foundation

/// How long sidebar selection and pose-control discovery may each wait before refusing a press.
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
  let discovery = try discoverDeviceHubWindow(udid: udid, deviceName: deviceName)
  let window = discovery.window
  defer {
    if discovery.revealedSidebar {
      _ = setDeviceHubSidebar(visible: false, window: window,
        deadline: ProcessInfo.processInfo.systemUptime + 0.5)
    }
  }
  let selected = try selectDevice(row: discovery.row, deviceName: deviceName, in: window)
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
      reopened: discovery.reopened,
      selected: selected
    )
  )
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
func sendDeviceHubReopenEvent(to pid: pid_t, timeout: TimeInterval) throws {
  let target = NSAppleEventDescriptor(processIdentifier: pid)
  let event = NSAppleEventDescriptor(
    eventClass: AEEventClass(kCoreEventClass),
    eventID: AEEventID(kAEReopenApplication),
    targetDescriptor: target,
    returnID: AEReturnID(kAutoGenerateReturnID),
    transactionID: AETransactionID(kAnyTransactionID)
  )
  do {
    _ = try event.sendEvent(options: [.noReply], timeout: min(5, max(0.001, timeout)))
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
/// the selection, because the title alone cannot tell such twins apart.
private func selectDevice(
  row: AXUIElement,
  deviceName: String,
  in window: AXUIElement
) throws -> Bool {
  let deadline = ProcessInfo.processInfo.systemUptime + deviceHubSettleDeadline
  AXUIElementSetMessagingTimeout(row, 0.25)
  AXUIElementSetMessagingTimeout(window, 0.25)
  let status = AXUIElementSetAttributeValue(row, kAXSelectedAttribute as CFString, kCFBooleanTrue)
  guard status == .success || status == .cannotComplete else {
    throw HelperError.commandFailed(
      "Device Hub refused to select \(deviceName) in its sidebar",
      details: ["reason": "device-hub-select-failed", "status": "\(status.rawValue)"]
    )
  }
  while ProcessInfo.processInfo.systemUptime < deadline {
    var selected: CFTypeRef?
    if AXUIElementCopyAttributeValue(row, kAXSelectedAttribute as CFString, &selected) == .success,
      (selected as? Bool) == true, windowShows(deviceName: deviceName, window) { return true }
    Thread.sleep(forTimeInterval: deviceHubPoll)
  }
  throw HelperError.commandFailed(
    "Device Hub did not confirm selection of \(deviceName)",
    details: ["reason": "device-hub-select-unconfirmed", "status": "\(status.rawValue)"]
  )
}

func deviceHubDeviceRow(udid: String, in window: AXUIElement, deadline: TimeInterval) -> AXUIElement? {
  guard let label = findDeviceHubElement(root: window, depth: 0, deadline: deadline, where: {
    stringAttribute($0, attribute: "AXIdentifier") == deviceHubDeviceRowIdentifier(udid: udid)
  }) else {
    return nil
  }
  var current: AXUIElement? = label
  while let element = current, ProcessInfo.processInfo.systemUptime < deadline {
    AXUIElementSetMessagingTimeout(element, Float(max(0.001, min(0.25, deadline - ProcessInfo.processInfo.systemUptime))))
    if stringAttribute(element, attribute: kAXRoleAttribute as String) == "AXRow" {
      return element
    }
    current = elementAttribute(element, attribute: kAXParentAttribute as String)
  }
  return nil
}

/// The action bar is rebuilt for the device the window shows, so right after a sidebar selection
/// the window already carries the new title while the pose controls are still being laid out.
/// The controls are therefore awaited, not looked up once.
private func awaitPoseButton(in window: AXUIElement, description: String) -> AXUIElement? {
  let deadline = ProcessInfo.processInfo.systemUptime + deviceHubSettleDeadline
  while true {
    if let button = poseButton(in: window, description: description, deadline: deadline) {
      return button
    }
    guard ProcessInfo.processInfo.systemUptime < deadline else { return nil }
    Thread.sleep(forTimeInterval: deviceHubPoll)
  }
}

/// The pose controls sit in the window's action bar as `AXButton`s described by their preset
/// name; the simulated screen inside the same window is an iOS content group whose own buttons
/// carry app labels, never these three.
private func poseButton(in window: AXUIElement, description: String, deadline: TimeInterval) -> AXUIElement? {
  return findDeviceHubElement(root: window, depth: 0, deadline: deadline) {
    stringAttribute($0, attribute: kAXRoleAttribute as String) == "AXButton"
      && stringAttribute($0, attribute: kAXDescriptionAttribute as String) == description
  }
}

func findDeviceHubElement(
  root: AXUIElement,
  depth: Int,
  deadline: TimeInterval,
  where matches: (AXUIElement) -> Bool
) -> AXUIElement? {
  let remaining = deadline - ProcessInfo.processInfo.systemUptime
  if depth > 14 || remaining <= 0 {
    return nil
  }
  AXUIElementSetMessagingTimeout(root, Float(min(0.25, remaining)))
  for child in children(of: root) {
    let remaining = deadline - ProcessInfo.processInfo.systemUptime
    guard remaining > 0 else { return nil }
    AXUIElementSetMessagingTimeout(child, Float(min(0.25, remaining)))
    if matches(child) {
      return child
    }
    if stringAttribute(child, attribute: kAXSubroleAttribute as String) == "iOSContentGroup" {
      continue
    }
    if let nested = findDeviceHubElement(root: child, depth: depth + 1, deadline: deadline, where: matches) {
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
