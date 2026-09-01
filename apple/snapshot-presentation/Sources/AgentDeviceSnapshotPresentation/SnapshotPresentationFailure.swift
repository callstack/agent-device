import Foundation

public enum SnapshotPresentationFailure: Error {
  case regularNodeOutsideCumulativeClip(index: Int, frame: SnapshotRect, clip: SnapshotRect)
  case regularDegenerateNodeIsActionable(index: Int, frame: SnapshotRect)

  public var code: String {
    "IOS_SNAPSHOT_PRESENTATION_FAILED"
  }

  public var qualityReasonCode: String {
    "presentation-failed"
  }

  public var message: String {
    switch self {
    case .regularNodeOutsideCumulativeClip(let index, _, _):
      return "regular snapshot node \(index) escaped its cumulative clip"
    case .regularDegenerateNodeIsActionable(let index, _):
      return "regular snapshot node \(index) with a frameless or degenerate frame was marked hittable"
    }
  }

  public var hint: String {
    "This is a runner presentation bug: report it with the failing command and the app under test."
  }
}
