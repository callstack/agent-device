// swift-tools-version: 5.9
import PackageDescription

// Development-only Swift package: never shipped, never built by an install. The npm payload is
// apple/macos-helper, whose manifest declares no test targets because their sources are not
// shipped. `Sources` is a symlink to ../macos-helper/Sources, so the helper's own sources compile
// here as testable modules and `swift test --package-path apple/macos-helper-tests` covers them.
// Keep the target list in step with the shipped manifest.
let package = Package(
  name: "agent-device-macos-helper-tests",
  platforms: [.macOS(.v13)],
  targets: [
    .target(
      name: "AgentDeviceMacOSInput"
    ),
    .executableTarget(
      name: "AgentDeviceMacOSHelper",
      dependencies: ["AgentDeviceMacOSInput"]
    ),
    .testTarget(
      name: "AgentDeviceMacOSInputTests",
      dependencies: ["AgentDeviceMacOSInput"]
    ),
    .testTarget(
      name: "AgentDeviceMacOSHelperTests",
      dependencies: ["AgentDeviceMacOSHelper"]
    ),
  ]
)
