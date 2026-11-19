import SwiftUI

// The watchOS runner host. XCTest needs a host app; the runner drives other apps by bundle ID.
// Spike (#4735): the counter button and the text field are probes for `tap` and `type`.
@main
struct AgentDeviceRunnerWatchApp: App {
  var body: some Scene {
    WindowGroup {
      SpikeProbeView()
    }
  }
}

struct SpikeProbeView: View {
  @State private var taps = 0
  @State private var text = ""

  var body: some View {
    ScrollView {
      VStack {
        Text("agent-device runner")
        Button("Tap me") { taps += 1 }
          .accessibilityIdentifier("spike-tap")
        Text("Taps: \(taps)").accessibilityIdentifier("spike-count")
        TextField("Type here", text: $text)
          .accessibilityIdentifier("spike-field")
        Text("Text: \(text)").accessibilityIdentifier("spike-echo")
      }
    }
  }
}
