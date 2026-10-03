import Foundation

// MARK: - Environment

enum RunnerEnv {
  static func resolvePort() -> UInt16 {
    if let env = ProcessInfo.processInfo.environment["AGENT_DEVICE_RUNNER_PORT"], let port = UInt16(env) {
      return port
    }
    for arg in CommandLine.arguments {
      if arg.hasPrefix("AGENT_DEVICE_RUNNER_PORT=") {
        let value = arg.replacingOccurrences(of: "AGENT_DEVICE_RUNNER_PORT=", with: "")
        if let port = UInt16(value) { return port }
      }
    }
    return 0
  }
}
