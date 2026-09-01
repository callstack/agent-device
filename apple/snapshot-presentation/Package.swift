// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "agent-device-snapshot-presentation",
  platforms: [
    .iOS(.v15),
    .macOS(.v13),
  ],
  products: [
    .library(
      name: "AgentDeviceSnapshotPresentation",
      targets: ["AgentDeviceSnapshotPresentation"]
    ),
    .executable(
      name: "snapshot-presentation-conformance",
      targets: ["SnapshotPresentationConformance"]
    ),
  ],
  targets: [
    .target(name: "AgentDeviceSnapshotPresentation"),
    .executableTarget(
      name: "SnapshotPresentationConformance",
      dependencies: ["AgentDeviceSnapshotPresentation"]
    ),
    .testTarget(
      name: "AgentDeviceSnapshotPresentationTests",
      dependencies: ["AgentDeviceSnapshotPresentation"]
    ),
  ]
)
