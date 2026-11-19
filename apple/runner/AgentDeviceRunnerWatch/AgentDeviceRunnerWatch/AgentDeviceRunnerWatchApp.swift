import SwiftUI

// The watchOS runner host. XCTest needs a host app; the runner drives other apps by bundle ID.
// Spike (#4735): the screens below are probes for taps, typing, and watch gestures.
@main
struct AgentDeviceRunnerWatchApp: App {
  var body: some Scene {
    WindowGroup {
      NavigationStack { SpikeHome() }
    }
  }
}

struct SpikeHome: View {
  @State private var taps = 0
  @State private var text = ""
  @State private var rows = ["Row 1", "Row 2", "Row 3"]
  @State private var lastAction = "none"

  var body: some View {
    List {
      NavigationLink("Vertical") { VerticalPages() }
      NavigationLink("Gestures") { GestureProbe() }
      NavigationLink("Pages") { HorizontalPages() }
      NavigationLink("Detail") { Text("Detail screen").navigationTitle("Detail") }
      Text("Last: \(lastAction)").accessibilityIdentifier("spike-last")
      Button("Tap me") { taps += 1 }.accessibilityIdentifier("spike-tap")
      Text("Taps: \(taps)").accessibilityIdentifier("spike-count")
      TextField("Type here", text: $text).accessibilityIdentifier("spike-field")
      ForEach(rows, id: \.self) { row in
        Text(row)
          .swipeActions(edge: .trailing) {
            Button("Delete", role: .destructive) {
              rows.removeAll { $0 == row }
              lastAction = "deleted \(row)"
            }
          }
          .swipeActions(edge: .leading) {
            Button("Pin") { lastAction = "pinned \(row)" }
          }
      }
    }
    .navigationTitle("Spike")
  }
}

struct HorizontalPages: View {
  var body: some View {
    TabView {
      Text("Page A").accessibilityIdentifier("page-a")
      Text("Page B").accessibilityIdentifier("page-b")
      Text("Page C").accessibilityIdentifier("page-c")
    }
    .tabViewStyle(.page)
  }
}

struct VerticalPages: View {
  var body: some View {
    TabView {
      Text("Vertical 1")
      Text("Vertical 2")
      Text("Vertical 3")
    }
    .tabViewStyle(.verticalPage)
  }
}

struct GestureProbe: View {
  @State private var drag = "none"
  @State private var magnify = "none"
  @State private var doubleTaps = 0

  var body: some View {
    VStack(spacing: 2) {
      Text("drag \(drag)").font(.footnote).accessibilityIdentifier("probe-drag")
      Text("mag \(magnify)").font(.footnote).accessibilityIdentifier("probe-mag")
      Text("dbl \(doubleTaps)").font(.footnote).accessibilityIdentifier("probe-dbl")
      Rectangle()
        .fill(Color.blue.opacity(0.4))
        .accessibilityIdentifier("probe-pad")
        .gesture(
          DragGesture(minimumDistance: 5).onEnded { value in
            drag = "\(Int(value.translation.width)),\(Int(value.translation.height))"
          }
        )
        .simultaneousGesture(TapGesture(count: 2).onEnded { doubleTaps += 1 })
      if #available(watchOS 11.0, *) {
        Button("Primary") { doubleTaps += 100 }
          .handGestureShortcut(.primaryAction)
          .accessibilityIdentifier("probe-primary")
      }
    }
    .navigationBarBackButtonHidden(false)
  }
}
