import Foundation
import RecordingSupport

func contractsFixtureURL(_ name: String, from filePath: String = #filePath) -> URL {
  URL(fileURLWithPath: filePath)
    .deletingLastPathComponent() // AgentDeviceSnapshotPresentationTests
    .deletingLastPathComponent() // Tests
    .deletingLastPathComponent() // snapshot-presentation
    .deletingLastPathComponent() // apple
    .deletingLastPathComponent() // repo root
    .appendingPathComponent("contracts")
    .appendingPathComponent("fixtures")
    .appendingPathComponent(name)
}
