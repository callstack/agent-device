import Foundation

/// A presentation failure is a runner-owned degradation, not evidence that the app published a
/// sparse accessibility tree. The capture plan maps this typed failure onto its existing quality
/// payload at the acquisition/presentation boundary.
enum SnapshotPresentationFailure: Error {
  case regularNodeOutsideCumulativeClip(index: Int, frame: SnapshotRect, clip: SnapshotRect)
  case regularDegenerateNodeIsActionable(index: Int, frame: SnapshotRect)

  var code: String { "IOS_SNAPSHOT_PRESENTATION_FAILED" }

  var qualityReasonCode: String { "presentation-failed" }

  var message: String {
    switch self {
    case .regularNodeOutsideCumulativeClip(let index, _, _):
      return "regular snapshot node \(index) escaped its cumulative clip"
    case .regularDegenerateNodeIsActionable(let index, _):
      return "regular snapshot node \(index) with a frameless or degenerate frame was marked hittable"
    }
  }

  var hint: String {
    "This is a runner presentation bug: report it with the failing command and the app under test."
  }
}

/// The choke-point check for the regular presentation. It consumes the folded presentation
/// nodes, not raw acquisition facts, so replacing the fold with reported geometry cannot silently
/// reach `PresentedNode` construction.
extension SnapshotPresentation {
  static func validateRegularInvariant(
    _ nodes: [SnapshotPresentationNode],
    viewport: CGRect,
    policy: SnapshotVisibilityFold.Policy
  ) throws {
    var nodesByIndex: [Int: SnapshotPresentationNode] = [:]
    for node in nodes {
      nodesByIndex[node.raw.index] = node
    }

    for node in nodes {
      let frame = cgRect(from: node.effectiveRect)
      guard !frame.isNull, !frame.isEmpty else {
        if node.raw.hittable {
          throw SnapshotPresentationFailure.regularDegenerateNodeIsActionable(
            index: node.raw.index,
            frame: node.effectiveRect
          )
        }
        continue
      }

      let clip = cumulativeClip(
        for: node,
        nodesByIndex: nodesByIndex,
        viewport: viewport,
        policy: policy
      )
      guard contains(frame, in: clip) else {
        throw SnapshotPresentationFailure.regularNodeOutsideCumulativeClip(
          index: node.raw.index,
          frame: node.effectiveRect,
          clip: snapshotRect(from: clip)
        )
      }
    }
  }

  private static func cumulativeClip(
    for node: SnapshotPresentationNode,
    nodesByIndex: [Int: SnapshotPresentationNode],
    viewport: CGRect,
    policy: SnapshotVisibilityFold.Policy
  ) -> CGRect {
    guard policy == .cursorProjected else { return viewport }

    var clip = viewport
    var parentIndex = node.raw.parentIndex
    var visited = Set<Int>()
    while let currentIndex = parentIndex, visited.insert(currentIndex).inserted,
      let parent = nodesByIndex[currentIndex]
    {
      if SnapshotVisibilityFold.scrollContainerTypeNames.contains(parent.raw.type) {
        let parentFrame = cgRect(from: parent.effectiveRect)
        if !parentFrame.isNull, !parentFrame.isEmpty {
          clip = clip.intersection(parentFrame)
        }
      }
      parentIndex = parent.raw.parentIndex
    }
    return clip
  }

  private static func contains(_ frame: CGRect, in clip: CGRect) -> Bool {
    guard !clip.isNull, !clip.isEmpty else { return false }
    let tolerance = 0.0001
    return frame.minX >= clip.minX - tolerance
      && frame.minY >= clip.minY - tolerance
      && frame.maxX <= clip.maxX + tolerance
      && frame.maxY <= clip.maxY + tolerance
  }

  private static func cgRect(from rect: SnapshotRect) -> CGRect {
    CGRect(x: rect.x, y: rect.y, width: rect.width, height: rect.height)
  }

  private static func snapshotRect(from rect: CGRect) -> SnapshotRect {
    SnapshotRect(
      x: Double(rect.minX),
      y: Double(rect.minY),
      width: Double(rect.width),
      height: Double(rect.height)
    )
  }
}

extension RunnerTests {
  static func snapshotCaptureFailure(
    for failure: SnapshotPresentationFailure
  ) -> SnapshotCaptureFailure {
    SnapshotCaptureFailure(
      code: failure.code,
      message: failure.message,
      hint: failure.hint,
      qualityReasonCode: failure.qualityReasonCode
    )
  }

  static func snapshotQualityReasonCode(for failure: SnapshotCaptureFailure) -> String {
    failure.qualityReasonCode
      ?? (Self.isAxSnapshotFailure(failure) ? "ax-rejected" : "capture-failed")
  }
}
