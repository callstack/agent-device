import XCTest
import Network

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
extension RunnerTests {
  func testListenerPeerAdmitsLoopbackAndTunnelAndRefusesADirectNetworkPeer() {
    XCTAssertEqual(
      RunnerListenerPeer.classify(isLoopbackAddress: true, interfaceTypes: [.loopback]),
      .loopback
    )
    // Observed on a device: the CoreDevice tunnel is available only on utun (.other).
    XCTAssertEqual(
      RunnerListenerPeer.classify(isLoopbackAddress: false, interfaceTypes: [.other]),
      .tunnel
    )
    for direct: [NWInterface.InterfaceType] in [[.wifi], [.wiredEthernet], [.cellular], [.other, .wifi], []] {
      XCTAssertEqual(
        RunnerListenerPeer.classify(isLoopbackAddress: false, interfaceTypes: direct),
        .directNetwork,
        "\(direct)"
      )
    }
  }

  func testListenerPeerRequiresExplicitForwardingForDirectNetworkAccess() {
    XCTAssertFalse(RunnerListenerPeer.directNetwork.isAdmitted(acceptsForwardedConnections: false))
    XCTAssertTrue(RunnerListenerPeer.directNetwork.isAdmitted(acceptsForwardedConnections: true))
    for peer: RunnerListenerPeer in [.loopback, .tunnel] {
      XCTAssertTrue(peer.isAdmitted(acceptsForwardedConnections: false))
      XCTAssertTrue(peer.isAdmitted(acceptsForwardedConnections: true))
    }
  }

  func testListenerPeerRecognizesEveryLoopbackAddressForm() {
    let peer = { (host: String) in NWEndpoint.hostPort(host: NWEndpoint.Host(host), port: 8100) }
    XCTAssertTrue(RunnerListenerPeer.isLoopback(peer("127.0.0.1")))
    XCTAssertTrue(RunnerListenerPeer.isLoopback(peer("::1")))
    XCTAssertTrue(RunnerListenerPeer.isLoopback(peer("::ffff:127.0.0.1")))
    XCTAssertFalse(RunnerListenerPeer.isLoopback(peer("172.20.10.1")))
    XCTAssertFalse(RunnerListenerPeer.isLoopback(peer("fd00::1")))
  }
}
#endif
