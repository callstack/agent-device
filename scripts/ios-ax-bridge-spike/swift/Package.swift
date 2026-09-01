// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "agent-device-ios-ax-bridge-spike",
  platforms: [.macOS(.v13)],
  products: [
    .executable(
      name: "agent-device-ios-ax-bridge-spike",
      targets: ["AgentDeviceIosAxBridgeSpike"]
    ),
  ],
  targets: [
    .executableTarget(
      name: "AgentDeviceIosAxBridgeSpike"
    ),
  ]
)
