import Foundation

// iOS out-of-process system surfaces observed and driven IN PLACE, never activated: activating such
// a host cancels what it presents (issue #2438; rationale in docs/adr/0004). Membership and each
// host's rationale live in the golden fixture contracts/fixtures/ios-system-surface-hosts.json,
// mirrored by the TS twin packages/contracts/src/ios-system-surface.ts; drift fails on either side
// without a simulator.
enum SystemSurfaceHostKind: String {
  case webAuth = "web-auth"
  case payment = "payment"
}

struct SystemSurfaceHost: Equatable {
  let bundleId: String
  let kind: SystemSurfaceHostKind
}

enum SystemSurfaceHostRegistry {
  static let hosts: [SystemSurfaceHost] = [
    SystemSurfaceHost(bundleId: "com.apple.SafariViewService", kind: .webAuth),
    SystemSurfaceHost(bundleId: "com.apple.PassbookUIService", kind: .payment),
  ]
}
