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

  public static func shouldAcquireChildren(
    for hint: CaptureHint,
    rawDepth: Int,
    regularPresentedDepth: Int
  ) -> Bool {
    if let rawLimit = hint.rawTraversalDepth {
      return rawDepth < rawLimit
    }
    if let presentedLimit = hint.regularPresentedDepth {
      return regularPresentedDepth < presentedLimit
    }
    return true
  }

  public static func regularTraversalTransition(
    for raw: RawAXNode,
    parentPresentedDepth: Int,
    parentTraversal: SnapshotVisibilityFold.TraversalState,
    hint: CaptureHint,
    rawDepth: Int,
    viewport: CGRect,
    hasChildren: Bool,
    isDuplicate: Bool,
    policy: SnapshotVisibilityFold.Policy = .platformDefault
  ) -> (
    presentedDepth: Int,
    traversal: SnapshotVisibilityFold.TraversalState,
    shouldVisitChildren: Bool
  ) {
    guard hint.regularPresentedDepth != nil else {
      return (
        parentPresentedDepth,
        parentTraversal,
        shouldAcquireChildren(
          for: hint,
          rawDepth: rawDepth,
          regularPresentedDepth: parentPresentedDepth
        )
      )
    }

    let visibility = SnapshotVisibilityFold.traversalDecision(
      for: raw,
      parent: parentTraversal,
      viewport: viewport,
      interactiveOnly: hint.interactiveOnly,
      hasChildren: hasChildren,
      policy: policy
    )
    let presentedDepth = regularPresentedDepth(
      for: raw,
      parentPresentedDepth: parentPresentedDepth,
      visibility: visibility
    )
    let nextPresentedDepth = isDuplicate ? parentPresentedDepth : presentedDepth
    let nextTraversal = isDuplicate ? parentTraversal : visibility.descendants
    let descendantsMayBeVisible = isDuplicate
      ? parentTraversal.descendantsMayBeVisible
      : visibility.descendantsMayBeVisible
    return (
      nextPresentedDepth,
      nextTraversal,
      shouldAcquireChildren(
        for: hint,
        rawDepth: rawDepth,
        regularPresentedDepth: nextPresentedDepth
      ) && descendantsMayBeVisible
    )
  }

  public static func regularPresentedDepth(
    for raw: RawAXNode,
    parentPresentedDepth: Int,
    visibility: SnapshotVisibilityFold.TraversalDecision
  ) -> Int {
    guard raw.parentIndex != nil else { return 0 }
    return visibility.isIncluded && isEligibleForRegularPresentation(raw)
      ? parentPresentedDepth + 1
      : parentPresentedDepth
  }

  public static func singleElementRead(_ node: RawAXNode) -> PresentedNode {
    PresentedNode(presenting: node)
  }
}
