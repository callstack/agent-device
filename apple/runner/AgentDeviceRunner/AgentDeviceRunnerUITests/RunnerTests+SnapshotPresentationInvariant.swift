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
  private struct InvariantValidationMetrics {
    var parentClipLookups = 0
  }

  static func validateRegularInvariant(
    _ nodes: [SnapshotPresentationNode],
    viewport: CGRect,
    policy: SnapshotVisibilityFold.Policy
  ) throws {
    var metrics = InvariantValidationMetrics()
    try validateRegularInvariant(
      nodes,
      viewport: viewport,
      policy: policy,
      metrics: &metrics
    )
  }

  private static func validateRegularInvariant(
    _ nodes: [SnapshotPresentationNode],
    viewport: CGRect,
    policy: SnapshotVisibilityFold.Policy,
    metrics: inout InvariantValidationMetrics
  ) throws {
    // SnapshotVisibilityFold emits preorder, so every parent clip is available when its child is
    // visited. The effective frame already contains the fold's viewport/ancestor clipping. Cache
    // a scroll node's effective frame for descendants; the node itself is checked against its
    // parent's context.
    var clipIncludingNodeByIndex: [Int: CGRect] = [:]
    clipIncludingNodeByIndex.reserveCapacity(nodes.count)

    for node in nodes {
      let ancestorClip: CGRect
      if let parentIndex = node.raw.parentIndex {
        metrics.parentClipLookups += 1
        ancestorClip = clipIncludingNodeByIndex[parentIndex] ?? viewport
      } else {
        ancestorClip = viewport
      }

      let frame = cgRect(from: node.effectiveRect)
      let clipIncludingNode: CGRect
      if policy == .cursorProjected,
        SnapshotVisibilityFold.scrollContainerTypeNames.contains(node.raw.type),
        !frame.isNull,
        !frame.isEmpty
      {
        clipIncludingNode = frame
      } else {
        clipIncludingNode = ancestorClip
      }
      clipIncludingNodeByIndex[node.raw.index] = clipIncludingNode

      guard !frame.isNull, !frame.isEmpty else {
        if node.raw.hittable {
          throw SnapshotPresentationFailure.regularDegenerateNodeIsActionable(
            index: node.raw.index,
            frame: node.effectiveRect
          )
        }
        continue
      }

      guard contains(frame, in: ancestorClip) else {
        throw SnapshotPresentationFailure.regularNodeOutsideCumulativeClip(
          index: node.raw.index,
          frame: node.effectiveRect,
          clip: snapshotRect(from: ancestorClip)
        )
      }
    }
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

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
  struct InvariantValidationStats {
    let parentClipLookups: Int
  }

  static func validateRegularInvariantForTesting(
    _ nodes: [SnapshotPresentationNode],
    viewport: CGRect,
    policy: SnapshotVisibilityFold.Policy
  ) throws -> InvariantValidationStats {
    var metrics = InvariantValidationMetrics()
    try validateRegularInvariant(
      nodes,
      viewport: viewport,
      policy: policy,
      metrics: &metrics
    )
    return InvariantValidationStats(parentClipLookups: metrics.parentClipLookups)
  }
#endif
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
