import Network

/// Who reached the runner listener, decided once per connection from its path. The host reaches the
/// runner only over loopback (a simulator or macOS host, or usbmux on a device) or through the
/// device's CoreDevice tunnel, a `utun` interface of type `.other`. A peer on any other interface
/// reached the device directly over a shared network and requires explicit forwarding support.
enum RunnerListenerPeer: Equatable {
  /// May hold an idle connection: the simulator listener watch (`runner-retention.ts`) does, to
  /// learn when the runner dies.
  case loopback
  case tunnel
  case directNetwork

  func isAdmitted(acceptsForwardedConnections: Bool) -> Bool {
    self != .directNetwork || acceptsForwardedConnections
  }

  static func of(_ connection: NWConnection) -> RunnerListenerPeer {
    classify(
      isLoopbackAddress: isLoopback(connection.endpoint),
      interfaceTypes: connection.currentPath?.availableInterfaces.map(\.type) ?? []
    )
  }

  static func classify(
    isLoopbackAddress: Bool,
    interfaceTypes: [NWInterface.InterfaceType]
  ) -> RunnerListenerPeer {
    if isLoopbackAddress { return .loopback }
    // A tunnel's path can also report the physical interface it rides on as used, so only the
    // interfaces the connection is available on decide.
    if !interfaceTypes.isEmpty && interfaceTypes.allSatisfy({ $0 == .other }) { return .tunnel }
    return .directNetwork
  }

  static func isLoopback(_ endpoint: NWEndpoint) -> Bool {
    guard case .hostPort(let host, _) = endpoint else { return false }
    switch host {
    case .ipv4(let address): return address.isLoopback
    case .ipv6(let address): return address.isLoopback || (address.asIPv4?.isLoopback ?? false)
    default: return false
    }
  }
}
