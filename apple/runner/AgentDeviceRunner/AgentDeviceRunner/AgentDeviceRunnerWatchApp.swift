import SwiftUI

/// The watchOS host the runner's XCTest bundle launches. The runner drives other apps by bundle ID,
/// so the host shows only its title, like the UIKit host on the other Apple OSes.
@main
struct AgentDeviceRunnerWatchApp: App {
  var body: some Scene {
    WindowGroup {
      Text("Agent Device Runner")
    }
  }
}
