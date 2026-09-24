import Foundation
import CoreGraphics

/// What `SnapshotPresentation` guarantees about the regular projection it just folded.
///
/// The viewport enters exactly once, as the root of the cumulative ancestor clip. When the capture
/// has no viewport box the clip has no root, so containment has nothing to violate — that is the
/// absence of an answer, not an unbounded clip, and it is why `SnapshotViewport.rect` is `nil` here
/// rather than a box that swallows every check. The degenerate-node rule below does not consult the
/// viewport at all, so a capture that cannot locate the screen still cannot present a null or empty
/// frame as actionable (#2638 reads that verdict as evidence a wrapper is inert).
public enum SnapshotPresentationInvariant {
  struct ValidationStats: Equatable {
    let parentClipLookups: Int

    init(parentClipLookups: Int) {
      self.parentClipLookups = parentClipLookups
    }
  }

  public static func validateRegular(
    _ nodes: [SnapshotPresentationNode],
    viewport: SnapshotViewport,
    policy: SnapshotVisibilityFold.Policy
  ) throws {
    _ = try validateRegularWithStats(nodes, viewport: viewport, policy: policy)
  }

  static func validateRegularWithStats(
    _ nodes: [SnapshotPresentationNode],
    viewport: SnapshotViewport,
    policy: SnapshotVisibilityFold.Policy
  ) throws -> ValidationStats {
    var parentClipLookups = 0
    var clipIncludingNodeByIndex: [Int: CGRect?] = [:]
    clipIncludingNodeByIndex.reserveCapacity(nodes.count)
    let rootClip = viewport.rect

    for node in nodes {
      let ancestorClip: CGRect?
      if let parentIndex = node.raw.parentIndex {
        parentClipLookups += 1
        ancestorClip = clipIncludingNodeByIndex[parentIndex] ?? rootClip
      } else {
        ancestorClip = rootClip
      }

      let frame = node.effectiveRect.cgRect
      let clipIncludingNode: CGRect?
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

      if let clip = ancestorClip, !contains(frame, in: clip) {
        throw SnapshotPresentationFailure.regularNodeOutsideCumulativeClip(
          index: node.raw.index,
          frame: node.effectiveRect,
          clip: SnapshotRect(clip)
        )
      }
    }

    return ValidationStats(parentClipLookups: parentClipLookups)
  }

  private static func contains(_ frame: CGRect, in clip: CGRect) -> Bool {
    guard !clip.isNull, !clip.isEmpty else { return false }
    let tolerance = 0.0001
    return frame.minX >= clip.minX - tolerance
      && frame.minY >= clip.minY - tolerance
      && frame.maxX <= clip.maxX + tolerance
      && frame.maxY <= clip.maxY + tolerance
  }

}
