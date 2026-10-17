// swift-tools-version: 5.9
import PackageDescription

// The npm package ships this directory and builds it on the user's machine, so it declares only
// what the helper binary needs. SwiftPM refuses to build a package whose declared test target has
// no sources, and the tests are not shipped; apple/macos-helper-tests is the manifest that owns
// them and compiles these same sources with them.
let package = Package(
  name: "agent-device-macos-helper",
  platforms: [.macOS(.v13)],
  products: [
    .executable(
      name: "agent-device-macos-helper",
      targets: ["AgentDeviceMacOSHelper"]
    ),
  ],
  targets: [
    .target(
      name: "AgentDeviceMacOSInput"
    ),
    .executableTarget(
      name: "AgentDeviceMacOSHelper",
      dependencies: ["AgentDeviceMacOSInput"]
    ),
  ]
)
