import Foundation
import CoreGraphics

public enum SnapshotPresentationInvariant {
  public struct ValidationStats: Equatable {
    public let parentClipLookups: Int

    public init(parentClipLookups: Int) {
      self.parentClipLookups = parentClipLookups
    }
  }

  public static func validateRegular(
    _ nodes: [SnapshotPresentationNode],
    viewport: CGRect,
    policy: SnapshotVisibilityFold.Policy
  ) throws {
    _ = try validateRegularWithStats(nodes, viewport: viewport, policy: policy)
  }

  public static func validateRegularWithStats(
    _ nodes: [SnapshotPresentationNode],
    viewport: CGRect,
    policy: SnapshotVisibilityFold.Policy
  ) throws -> ValidationStats {
    var parentClipLookups = 0
    var clipIncludingNodeByIndex: [Int: CGRect] = [:]
    clipIncludingNodeByIndex.reserveCapacity(nodes.count)

    for node in nodes {
      let ancestorClip: CGRect
      if let parentIndex = node.raw.parentIndex {
        parentClipLookups += 1
        ancestorClip = clipIncludingNodeByIndex[parentIndex] ?? viewport
      } else {
        ancestorClip = viewport
      }

      let frame = node.effectiveRect.cgRect
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

  private static func snapshotRect(from rect: CGRect) -> SnapshotRect {
    SnapshotRect(
      x: Double(rect.minX),
      y: Double(rect.minY),
      width: Double(rect.width),
      height: Double(rect.height)
    )
  }
}
