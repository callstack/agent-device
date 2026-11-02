import Foundation
import Network

// MARK: - Environment

/// What the daemon hands the runner through the session xctestrun's `EnvironmentVariables`. Both
/// parts are required: a runner on a port of its own choosing is one no daemon can reach, and one
/// without a token would listen to anyone.
struct RunnerListenerConfiguration {
  let port: NWEndpoint.Port
  let token: RunnerListenerToken
  let bindAddress: IPv4Address?

  static func fromEnvironment(
    _ environment: [String: String] = ProcessInfo.processInfo.environment
  ) -> RunnerListenerConfiguration? {
    guard
      let rawPort = environment["AGENT_DEVICE_RUNNER_PORT"].flatMap({ UInt16($0) }), rawPort > 0,
      let port = NWEndpoint.Port(rawValue: rawPort),
      let token = RunnerListenerToken(environment["AGENT_DEVICE_RUNNER_TOKEN"])
    else {
      return nil
    }
    var bindAddress: IPv4Address?
    if let rawAddress = environment["AGENT_DEVICE_RUNNER_BIND_IP"] {
      guard let address = IPv4Address(rawAddress), address != .any else { return nil }
      bindAddress = address
    }
    return RunnerListenerConfiguration(port: port, token: token, bindAddress: bindAddress)
  }
}
