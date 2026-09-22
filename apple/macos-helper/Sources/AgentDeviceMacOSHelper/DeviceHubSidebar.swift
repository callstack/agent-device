import AgentDeviceMacOSDeviceHub
import ApplicationServices
import Foundation

func identifyDeviceHubRow(
  udid: String,
  candidate: DeviceHubWindowCandidate,
  deadline: TimeInterval
) -> DeviceHubRowLookup {
  let now = ProcessInfo.processInfo.systemUptime
  let visibleRowDeadline = now + max(0, deadline - now) / 3
  if let row = deviceHubDeviceRow(udid: udid, in: candidate.window, deadline: visibleRowDeadline) {
    return .identified(row, restoreSidebar: false)
  }
  let searchDeadline = deadline - 0.25
  guard let button = deviceHubSidebarButton(visible: true, window: candidate.window, deadline: searchDeadline) else {
    return ProcessInfo.processInfo.systemUptime >= searchDeadline ? .timedOut : .sidebarUnavailable
  }
  var transferCleanup = false
  defer {
    if !transferCleanup {
      _ = setDeviceHubSidebar(visible: false, window: candidate.window, deadline: deadline)
    }
  }
  let status = pressDeviceHubSidebarButton(button, deadline: searchDeadline)
  guard status == .success || status == .cannotComplete else { return .unconfirmed }
  repeat {
    if let row = deviceHubDeviceRow(udid: udid, in: candidate.window, deadline: searchDeadline) {
      transferCleanup = true
      return .identified(row, restoreSidebar: true)
    }
    let remaining = searchDeadline - ProcessInfo.processInfo.systemUptime
    if remaining <= 0 { return .timedOut }
    Thread.sleep(forTimeInterval: min(0.05, remaining))
  } while ProcessInfo.processInfo.systemUptime < searchDeadline
  return .timedOut
}

func setDeviceHubSidebar(visible: Bool, window: AXUIElement, deadline: TimeInterval) -> Bool {
  guard let button = deviceHubSidebarButton(visible: visible, window: window, deadline: deadline) else { return false }
  return pressDeviceHubSidebarButton(button, deadline: deadline) == .success
}

private func deviceHubSidebarButton(visible: Bool, window: AXUIElement, deadline: TimeInterval) -> AXUIElement? {
  let description = visible ? "Show Sidebar" : "Hide Sidebar"
  return findDeviceHubElement(root: window, depth: 0, deadline: deadline) {
    stringAttribute($0, attribute: kAXRoleAttribute as String) == "AXButton"
      && stringAttribute($0, attribute: kAXDescriptionAttribute as String) == description
  }
}

private func pressDeviceHubSidebarButton(_ button: AXUIElement, deadline: TimeInterval) -> AXError {
  let remaining = deadline - ProcessInfo.processInfo.systemUptime
  guard remaining > 0 else { return .cannotComplete }
  AXUIElementSetMessagingTimeout(button, Float(min(0.1, remaining)))
  return AXUIElementPerformAction(button, kAXPressAction as CFString)
}
