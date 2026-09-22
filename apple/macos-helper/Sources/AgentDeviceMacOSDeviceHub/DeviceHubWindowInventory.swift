import ApplicationServices

package enum DeviceHubWindowRead {
  case available([AXUIElement])
  case failed(Int32)
}

package struct DeviceHubWindowCandidate {
  package let processID: Int32
  package let window: AXUIElement
}

package enum DeviceHubRowLookup {
  case identified(AXUIElement, restoreSidebar: Bool)
  case sidebarUnavailable
  case unconfirmed
  case timedOut

  package var diagnostic: String {
    switch self {
    case .identified: return "identified"
    case .sidebarUnavailable: return "sidebar-unavailable"
    case .unconfirmed: return "row-unconfirmed"
    case .timedOut: return "timed-out"
    }
  }
}

package struct DeviceHubWindowInventory {
  package private(set) var candidates: [DeviceHubWindowCandidate] = []
  package private(set) var emptyProcessIDs: [Int32] = []
  package private(set) var failures: [Int32: Int32] = [:]
  package private(set) var candidateOutcomes: [String] = []
  package private(set) var budgetExpired = false

  package init() {}

  package mutating func record(processID: Int32, read: DeviceHubWindowRead) {
    switch read {
    case .available(let windows):
      if windows.isEmpty { emptyProcessIDs.append(processID) }
      candidates.append(contentsOf: windows.map { DeviceHubWindowCandidate(processID: processID, window: $0) })
    case .failed(let status):
      failures[processID] = status
    }
  }

  package mutating func record(candidate: Int, outcome: DeviceHubRowLookup) {
    candidateOutcomes.append("\(candidates[candidate].processID):\(candidate):\(outcome.diagnostic)")
  }

  package mutating func expireBudget() { budgetExpired = true }

  package func processesToReopen(attempted: Set<Int32>) -> [Int32] {
    budgetExpired ? [] : emptyProcessIDs.filter { !attempted.contains($0) }
  }

  package func failureReason(reopenFailures: [Int32: String] = [:]) -> String {
    if !failures.isEmpty { return "device-hub-window-read-failed" }
    if budgetExpired { return "device-hub-discovery-timeout" }
    if !candidates.isEmpty { return "device-hub-identity-unconfirmed" }
    if let reason = reopenFailures.sorted(by: { $0.key < $1.key }).first?.value { return reason }
    return "device-hub-window-missing"
  }
}
