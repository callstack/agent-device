import AgentDeviceSnapshotPresentation

enum SnapshotPresentation {
  static func present(
    _ acquisition: SnapshotAcquisition,
    options: PresentationOptions
  ) throws -> SnapshotBackendCapture? {
    let requested = captureHint(for: options)
    guard let result = try AgentDeviceSnapshotPresentation.SnapshotPresentation.present(
      acquisition,
      options: options
    ) else {
      NSLog(
        "AGENT_DEVICE_RUNNER_SNAPSHOT_PROJECTION_MISMATCH requested=%@ acquired=%@",
        requested.projection.rawValue,
        acquisition.hint.projection.rawValue
      )
      return nil
    }
    return snapshotBackendCapture(from: result)
  }

  static func presentRegular(
    _ acquisition: SnapshotAcquisition,
    options: PresentationOptions,
    policy: SnapshotVisibilityFold.Policy = .platformDefault
  ) throws -> SnapshotBackendCapture {
    snapshotBackendCapture(
      from: try AgentDeviceSnapshotPresentation.SnapshotPresentation.presentRegular(
        acquisition,
        options: options,
        policy: policy
      )
    )
  }

  static func presentRaw(
    _ acquisition: SnapshotAcquisition,
    options: PresentationOptions
  ) -> SnapshotBackendCapture {
    snapshotBackendCapture(
      from: AgentDeviceSnapshotPresentation.SnapshotPresentation.presentRaw(
        acquisition,
        options: options
      )
    )
  }

  static func captureHint(for options: PresentationOptions) -> CaptureHint {
    AgentDeviceSnapshotPresentation.SnapshotPresentation.captureHint(for: options)
  }

  static func shouldAcquireChildren(
    for hint: CaptureHint,
    rawDepth: Int,
    regularPresentedDepth: Int
  ) -> Bool {
    AgentDeviceSnapshotPresentation.SnapshotPresentation.shouldAcquireChildren(
      for: hint,
      rawDepth: rawDepth,
      regularPresentedDepth: regularPresentedDepth
    )
  }

  static func regularTraversalTransition(
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
    AgentDeviceSnapshotPresentation.SnapshotPresentation.regularTraversalTransition(
      for: raw,
      parentPresentedDepth: parentPresentedDepth,
      parentTraversal: parentTraversal,
      hint: hint,
      rawDepth: rawDepth,
      viewport: viewport,
      hasChildren: hasChildren,
      isDuplicate: isDuplicate,
      policy: policy
    )
  }

  static func regularPresentedDepth(
    for raw: RawAXNode,
    parentPresentedDepth: Int,
    visibility: SnapshotVisibilityFold.TraversalDecision
  ) -> Int {
    AgentDeviceSnapshotPresentation.SnapshotPresentation.regularPresentedDepth(
      for: raw,
      parentPresentedDepth: parentPresentedDepth,
      visibility: visibility
    )
  }

  static func singleElementRead(_ node: RawAXNode) -> PresentedNode {
    AgentDeviceSnapshotPresentation.SnapshotPresentation.singleElementRead(node)
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
    let stats = try SnapshotPresentationInvariant.validateRegularWithStats(
      nodes,
      viewport: viewport,
      policy: policy
    )
    return InvariantValidationStats(parentClipLookups: stats.parentClipLookups)
  }
#endif

  private static func snapshotBackendCapture(
    from result: SnapshotPresentationResult
  ) -> SnapshotBackendCapture {
    SnapshotBackendCapture(
      payload: DataPayload(nodes: result.nodes, truncated: result.truncated),
      effectiveDepth: result.effectiveDepth,
      customActions: result.customActions,
      qualityPayload: result.qualityNodes.map {
        DataPayload(nodes: $0, truncated: result.truncated)
      }
    )
  }
}
