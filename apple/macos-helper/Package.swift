// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "agent-device-macos-helper",
  platforms: [.macOS(.v13)],
  products: [
    .executable(
      name: "agent-device-macos-helper",
      targets: ["AgentDeviceMacOSHelper"]
    ),
    .executable(
      name: "agent-device-ios-ax-bridge-spike",
      targets: ["AgentDeviceIosAxBridgeSpike"]
    ),
  ],
  targets: [
    .executableTarget(
      name: "AgentDeviceMacOSHelper"
    ),
    .executableTarget(
      name: "AgentDeviceIosAxBridgeSpike"
    ),
  ]
)
