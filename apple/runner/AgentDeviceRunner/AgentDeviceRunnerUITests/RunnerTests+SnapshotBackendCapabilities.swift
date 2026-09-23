import XCTest

enum SnapshotBackendEnvironment {
  case simulator
  case physicalDevice
}

/// How a backend's acquisition relates to a regular `--depth` request. Every backend serves the
/// request: `SnapshotPresentation` applies the presented-depth cut to whatever hierarchy was
/// acquired, and an acquisition that stopped short of the cut discloses that through its own
/// truncation verdict. The capability only says how much acquisition work the request bounds.
enum SnapshotRegularDepthCapability: String {
  /// The backend is flat: it acquires the root and one presented level, so a cut past depth 1
  /// returns the sweep unchanged.
  case flat
  /// Acquisition enumerates its hierarchy regardless of the request; the presented cut happens
  /// in presentation and the ladder's cap is disclosed as `effectiveDepth`.
  case presentationCut = "presentation-cut"
}

enum SnapshotBackendKind: String, CaseIterable {
  case recursiveTree = "tree"
  case querySweep = "queries"
  case privateAX = "private-ax"

  var isForceable: Bool {
    switch self {
    case .recursiveTree, .privateAX:
      return true
    case .querySweep:
      return false
    }
  }

  var hittableSemantics: String {
    "geometric-actionability"
  }

  var usesXCTestAccessibilityChannel: Bool {
    switch self {
    case .recursiveTree, .querySweep:
      return true
    case .privateAX:
      return false
    }
  }

  /// The raw projection is the acquired tree, so only a backend that enumerates a hierarchy can
  /// serve it. The query sweep answers an interactive element query: it has no hierarchy to
  /// return, and planning it for `--raw` is exactly how a raw request gets answered with regular
  /// membership.
  var supportsRawProjection: Bool {
    switch self {
    case .recursiveTree, .privateAX:
      return true
    case .querySweep:
      return false
    }
  }

  var regularDepthCapability: SnapshotRegularDepthCapability {
    switch self {
    case .recursiveTree:
      return .presentationCut
    case .querySweep:
      return .flat
    case .privateAX:
      return .presentationCut
    }
  }

  var isAvailableOnCurrentPlatform: Bool {
    #if os(iOS) && targetEnvironment(simulator)
      return isAvailable(on: .simulator)
    #else
      return isAvailable(on: .physicalDevice)
    #endif
  }

  func isAvailable(on environment: SnapshotBackendEnvironment) -> Bool {
    switch self {
    case .recursiveTree, .querySweep:
      return true
    case .privateAX:
      return environment == .simulator
    }
  }
}
