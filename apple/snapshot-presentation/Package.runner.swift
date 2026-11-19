// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "agent-device-snapshot-presentation",
  platforms: [
    .iOS(.v15),
    .macOS(.v13),
    .tvOS(.v15),
    .visionOS(.v1),
    .watchOS(.v10),
  ],
  products: [
    .library(
      name: "AgentDeviceSnapshotPresentation",
      targets: ["AgentDeviceSnapshotPresentation"]
    ),
  ],
  targets: [
    .target(name: "AgentDeviceSnapshotPresentation"),
  ]
)
