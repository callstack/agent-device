// swift-tools-version: 5.9
import PackageDescription

// The npm package ships this directory and builds it on the user's machine. The tests under
// Tests/ stay out of the tarball through `files`, except one PackStub.swift per test target:
// SwiftPM refuses any load of a package whose declared test target has no sources, so the
// shipped tree needs a source per test target for the install-time `swift build` to succeed.
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
