import Foundation

/// The decisions the Device Hub pose press makes without a window server: which control a pose
/// names, which window belongs to a device, and which sidebar row identifies it. They live apart
/// from the helper executable so the tests can exercise them without an accessibility session.

/// Device Hub's three pose presets for a foldable simulator, named as the helper's `--pose`
/// argument spells them. Each maps to the accessibility description of its action-bar button.
public enum DeviceHubPose: String, CaseIterable, Sendable {
  case closed
  case book
  case open

  public init?(argument: String) {
    self.init(rawValue: argument.lowercased())
  }

  /// The `AXDescription` Device Hub gives the button for this pose.
  public var controlDescription: String {
    switch self {
    case .closed: return "Closed"
    case .book: return "Book"
    case .open: return "Open"
    }
  }
}

/// Device Hub is launched through a trampoline, so LaunchServices registers it with no process
/// identifier; the process table is matched on the executable path instead.
public let deviceHubExecutableSuffix = "/DeviceHub.app/Contents/MacOS/DeviceHub"

/// The separator Device Hub puts between the device name and the OS in a window title.
public let deviceHubWindowTitleSeparator = " – "

/// Device Hub titles a device window `<device name> – <OS> <version>`, so a window shows the
/// device when its title is the name or the name followed by that exact separator. A bare
/// space would also match a simulator whose name merely extends this one ("iPhone Duo Lab").
public func deviceHubWindowShows(deviceName: String, title: String?) -> Bool {
  guard let title else { return false }
  return title == deviceName || title.hasPrefix(deviceName + deviceHubWindowTitleSeparator)
}

/// The accessibility identifier of the sidebar row for one simulator. The UDID is the one device
/// identity Device Hub exposes that two simulators sharing a name cannot confuse.
public func deviceHubDeviceRowIdentifier(udid: String) -> String {
  return "TableRow.Device.\(udid)"
}
