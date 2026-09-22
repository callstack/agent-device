import AgentDeviceMacOSDeviceHub
import AppKit
import ApplicationServices
import Darwin

struct DiscoveredDeviceHubWindow {
  let window: AXUIElement
  let reopened: Bool
  let row: AXUIElement
  let revealedSidebar: Bool
}

func discoverDeviceHubWindow(udid: String, deviceName: String) throws -> DiscoveredDeviceHubWindow {
  let deadline = ProcessInfo.processInfo.systemUptime + 8
  var reopened = Set<pid_t>()
  var reopenFailures: [pid_t: String] = [:]
  var inventory = DeviceHubWindowInventory()
  var processIDs: [pid_t] = []
  repeat {
    processIDs = deviceHubProcessIdentifiers()
    if processIDs.isEmpty {
      throw HelperError.commandFailed(
        "Xcode Device Hub is not running",
        details: ["reason": "device-hub-not-running", "bundleId": "com.apple.dt.Devices"]
      )
    }
    inventory = DeviceHubWindowInventory()
    for pid in processIDs {
      let remaining = deadline - ProcessInfo.processInfo.systemUptime
      guard remaining > 0 else { inventory.expireBudget(); break }
      let app = AXUIElementCreateApplication(pid)
      AXUIElementSetMessagingTimeout(app, Float(min(0.5, remaining)))
      var value: CFTypeRef?
      let status = AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &value)
      if status == .success, let windows = value as? [AXUIElement] {
        for window in windows { AXUIElementSetMessagingTimeout(window, 0.5) }
        inventory.record(processID: pid, read: .available(windows))
      } else {
        inventory.record(processID: pid, read: .failed(
          status == .success ? AXError.illegalArgument.rawValue : status.rawValue
        ))
      }
    }
    for (index, candidate) in inventory.candidates.enumerated() {
      let now = ProcessInfo.processInfo.systemUptime
      guard now < deadline else { inventory.expireBudget(); break }
      let candidateDeadline = now + (deadline - now) / Double(inventory.candidates.count - index) / 2
      let outcome = identifyDeviceHubRow(udid: udid, candidate: candidate, deadline: candidateDeadline)
      inventory.record(candidate: index, outcome: outcome)
      if case .identified(let row, let restoreSidebar) = outcome {
        return DiscoveredDeviceHubWindow(window: candidate.window,
          reopened: reopened.contains(candidate.processID), row: row, revealedSidebar: restoreSidebar)
      }
    }
    let attempted = reopened.union(reopenFailures.keys)
    for pid in inventory.processesToReopen(attempted: attempted) {
      guard ProcessInfo.processInfo.systemUptime < deadline else { inventory.expireBudget(); break }
      do {
        try sendDeviceHubReopenEvent(to: pid, timeout: deadline - ProcessInfo.processInfo.systemUptime)
        reopened.insert(pid)
      } catch let error as HelperError {
        guard case .commandFailed(_, let details) = error else { throw error }
        reopenFailures[pid] = details["reason"] ?? "device-hub-reopen-failed"
      }
    }
    let remaining = deadline - ProcessInfo.processInfo.systemUptime
    if remaining <= 0 { inventory.expireBudget(); break }
    Thread.sleep(forTimeInterval: min(0.25, remaining))
  } while ProcessInfo.processInfo.systemUptime < deadline

  let statuses = inventory.failures.sorted { $0.key < $1.key }
    .map { "\($0.key):\($0.value)" }.joined(separator: ",")
  throw HelperError.commandFailed(
    "Could not confirm a Device Hub window for the requested device",
    details: [
      "reason": inventory.failureReason(reopenFailures: reopenFailures),
      "reopenFailures": reopenFailures.sorted { $0.key < $1.key }.map { "\($0.key):\($0.value)" }.joined(separator: ","),
      "candidateOutcomes": inventory.candidateOutcomes.joined(separator: ","),
      "udid": udid,
      "deviceName": deviceName,
      "processIDs": processIDs.map(String.init).joined(separator: ","),
      "axWindowReadStatuses": statuses,
      "hostDisplayIDs": deviceHubHostDisplays().map { String($0) }.joined(separator: ","),
    ]
  )
}

private func deviceHubProcessIdentifiers() -> [pid_t] {
  let byteCount = proc_listpids(UInt32(PROC_ALL_PIDS), 0, nil, 0)
  guard byteCount > 0 else { return [] }
  var pids = [pid_t](repeating: 0, count: Int(byteCount) / MemoryLayout<pid_t>.size + 64)
  let filled = proc_listpids(UInt32(PROC_ALL_PIDS), 0, &pids, Int32(pids.count * MemoryLayout<pid_t>.size))
  guard filled > 0 else { return [] }
  return pids.prefix(Int(filled) / MemoryLayout<pid_t>.size).filter { pid in
    guard pid > 0 else { return false }
    var path = [CChar](repeating: 0, count: 4096)
    guard proc_pidpath(pid, &path, UInt32(path.count)) > 0 else { return false }
    return String(cString: path).hasSuffix(deviceHubExecutableSuffix)
  }.sorted()
}

private func deviceHubHostDisplays() -> [CGDirectDisplayID] {
  var count: UInt32 = 0
  guard CGGetActiveDisplayList(0, nil, &count) == .success else { return [] }
  var displays = [CGDirectDisplayID](repeating: 0, count: Int(count))
  guard CGGetActiveDisplayList(count, &displays, &count) == .success else { return [] }
  return Array(displays.prefix(Int(count)))
}
