import Foundation
import CoreGraphics

public enum SnapshotPresentation {
  public static func present(
    _ acquisition: SnapshotAcquisition,
    options: PresentationOptions
  ) throws -> SnapshotPresentationResult? {
    let requested = captureHint(for: options)
    guard acquisition.hint.projection == requested.projection else {
      return nil
    }
    switch requested.projection {
    case .regular:
      return try presentRegular(acquisition, options: options)
    case .raw:
      return presentRaw(acquisition, options: options)
    }
  }

  public static func presentRegular(
    _ acquisition: SnapshotAcquisition,
    options: PresentationOptions,
    policy: SnapshotVisibilityFold.Policy = .platformDefault
  ) throws -> SnapshotPresentationResult {
    let folded = SnapshotVisibilityFold.fold(
      acquisition.nodes,
      viewport: acquisition.viewport,
      interactiveOnly: options.interactiveOnly,
      policy: policy
    )
    try SnapshotPresentationInvariant.validateRegular(
      folded,
      viewport: acquisition.viewport,
      policy: policy
    )
    return project(
      folded,
      acquisition: acquisition,
      options: options,
      projection: .regular
    )
  }

  public static func presentRaw(
    _ acquisition: SnapshotAcquisition,
    options: PresentationOptions
  ) -> SnapshotPresentationResult {
    project(
      acquisition.nodes.map(SnapshotPresentationNode.reported),
      acquisition: acquisition,
      options: options,
      projection: .raw
    )
  }

  public static func captureHint(for options: PresentationOptions) -> CaptureHint {
    let scoped = SnapshotScopePolicy.isActive(options.scope)
    let projection: CaptureHint.Projection = options.raw ? .raw : .regular
    return CaptureHint(
      projection: projection,
      depth: scoped || projection == .regular ? nil : options.depth,
      regularPresentedDepth: scoped || projection == .raw ? nil : options.depth,
      interactiveOnly: projection == .raw ? false : options.interactiveOnly,
      customActions: options.customActions
    )
  }

  public static func singleElementRead(_ node: RawAXNode) -> PresentedNode {
    PresentedNode(presenting: node)
  }
}
