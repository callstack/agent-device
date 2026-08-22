import Foundation

enum SnapshotPresentation {
  /// The only snapshot node shape accepted by response payload assembly.
  ///
  /// The encoded shape intentionally remains byte-for-byte compatible with the former
  /// `SnapshotNode` wire model. Construction stays file-private to this presentation module:
  /// acquisition backends can return `RawAXNode` values, but cannot recreate a presented node.
  struct PresentedNode: Codable {
    let index: Int
    let type: String
    let label: String?
    let identifier: String?
    let value: String?
    let rect: SnapshotRect
    let enabled: Bool
    let focused: Bool?
    let selected: Bool?
    let hittable: Bool
    let depth: Int
    let parentIndex: Int?
    let hiddenContentAbove: Bool?
    let hiddenContentBelow: Bool?
    let actions: [String]?

    fileprivate init(presenting raw: RawAXNode) {
      self.init(
        presenting: raw,
        rect: raw.rect,
        index: raw.index,
        depth: raw.depth,
        parentIndex: raw.parentIndex
      )
    }

    fileprivate init(presenting node: SnapshotPresentationNode) {
      self.init(
        presenting: node.raw,
        rect: node.effectiveRect,
        index: node.raw.index,
        depth: node.raw.depth,
        parentIndex: node.raw.parentIndex
      )
    }

    fileprivate init(
      presenting raw: RawAXNode,
      rect: SnapshotRect,
      index: Int,
      depth: Int,
      parentIndex: Int?
    ) {
      self.index = index
      type = raw.type
      label = raw.label
      identifier = raw.identifier
      value = raw.value
      self.rect = rect
      enabled = raw.enabled
      focused = raw.focused
      selected = raw.selected
      hittable = raw.hittable
      self.depth = depth
      self.parentIndex = parentIndex
      hiddenContentAbove = raw.hiddenContentAbove
      hiddenContentBelow = raw.hiddenContentBelow
      actions = raw.actions
    }
  }

  private static let eligibleInteractiveTypes: Set<String> = [
    "Button",
    "Cell",
    "CheckBox",
    "CollectionView",
    "Link",
    "MenuItem",
    "Picker",
    "SearchField",
    "SecureTextField",
    "SegmentedControl",
    "Slider",
    "ScrollView",
    "Stepper",
    "Switch",
    "TabBar",
    "Table",
    "TextField",
    "TextView",
    "WebView",
  ]

  /// The capture plan's single presentation route for every snapshot backend.
  ///
  /// Refuses an acquisition captured for the other projection instead of presenting it under the
  /// requested label: a backend that ignores `--raw` loses its tier and the plan advances, rather
  /// than returning regular-projection membership called raw (#1797 D4).
  static func present(
    _ acquisition: SnapshotAcquisition,
    options: PresentationOptions
  ) throws -> SnapshotBackendCapture? {
    let requested = captureHint(for: options)
    guard acquisition.hint.projection == requested.projection else {
      NSLog(
        "AGENT_DEVICE_RUNNER_SNAPSHOT_PROJECTION_MISMATCH requested=%@ acquired=%@",
        requested.projection.rawValue,
        acquisition.hint.projection.rawValue
      )
      return nil
    }
    switch requested.projection {
    case .regular:
      return try presentRegular(acquisition, options: options)
    case .raw:
      return presentRaw(acquisition, options: options)
    }
  }

  /// Visible projection: the clip fold (viewport ∩ scroll clip, ancestor cursor, scroll hints),
  /// eligibility (an interactive type or non-empty semantic content, below the root carrier), and
  /// scope. The only interpreter of what a screen currently shows -- no backend folds its own
  /// visibility (#1797). Throws a typed `SnapshotPresentationFailure` if the folded result would
  /// violate the regular projection's geometry or actionability contract.
  static func presentRegular(
    _ acquisition: SnapshotAcquisition,
    options: PresentationOptions,
    policy: SnapshotVisibilityFold.Policy = .platformDefault
  ) throws -> SnapshotBackendCapture {
    let folded = SnapshotVisibilityFold.fold(
      acquisition.nodes,
      viewport: acquisition.viewport,
      interactiveOnly: options.interactiveOnly,
      policy: policy
    )
    try SnapshotPresentation.validateRegularInvariant(
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

  /// Diagnostic projection: the acquired tree, normalized. Scope and depth apply when explicitly
  /// requested; membership is never narrowed, so `interactive ⊆ regular ⊆ raw` holds for every
  /// backend (ADR 0004's raw contract).
  static func presentRaw(
    _ acquisition: SnapshotAcquisition,
    options: PresentationOptions
  ) -> SnapshotBackendCapture {
    project(
      acquisition.nodes.map(SnapshotPresentationNode.reported),
      acquisition: acquisition,
      options: options,
      projection: .raw
    )
  }

  /// Derives the one acquisition-facing view of a request, so no backend re-reads
  /// `PresentationOptions` and reaches its own conclusion about what to capture.
  ///
  /// Scope re-roots the presented tree and depth counts from that root, so a scoped request
  /// narrows neither: acquire broad, select once in presentation.
  static func captureHint(for options: PresentationOptions) -> CaptureHint {
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

  /// Raw depth is an acquisition limit. Regular depth is a presentation limit,
  /// so hierarchy-capable backends acquire through the structural-wrapper
  /// frontier until this presented depth is complete.
  static func shouldAcquireChildren(
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

  /// Computes one regular-tree frontier transition for both acquisition and its tests. The fold
  /// remains the sole visibility interpreter; this helper only carries its decision into the
  /// presentation-owned depth budget and the next traversal state.
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

  /// Shared depth accounting for the acquisition frontier. The fold supplies the same visibility
  /// decision used by regular presentation; this method adds only the presentation-owned semantic
  /// eligibility predicate.
  static func regularPresentedDepth(
    for raw: RawAXNode,
    parentPresentedDepth: Int,
    visibility: SnapshotVisibilityFold.TraversalDecision
  ) -> Int {
    guard raw.parentIndex != nil else { return 0 }
    return visibility.isIncluded && isEligibleForRegularPresentation(raw)
      ? parentPresentedDepth + 1
      : parentPresentedDepth
  }

  private static func project(
    _ projectionNodes: [SnapshotPresentationNode],
    acquisition: SnapshotAcquisition,
    options: PresentationOptions,
    projection: CaptureHint.Projection
  ) -> SnapshotBackendCapture {
    let scopedRawNodes = applyScope(to: projectionNodes, options: options, projection: projection)
    let nodes = presentedNodes(
      from: scopedRawNodes,
      projection: projection,
      maximumDepth: projection == .regular ? options.depth : nil
    )
    let qualityPayload: DataPayload? = SnapshotScopePolicy.isActive(options.scope)
      ? DataPayload(
        nodes: presentedNodes(from: projectionNodes, projection: projection, maximumDepth: nil),
        truncated: acquisition.truncated
      )
      : nil
    return SnapshotBackendCapture(
      payload: DataPayload(
        nodes: nodes,
        truncated: acquisition.truncated
      ),
      effectiveDepth: acquisition.effectiveDepth,
      customActions: acquisition.customActions,
      qualityPayload: qualityPayload
    )
  }

  /// Explicit carve-out for selector queries and system-modal reads that intentionally return one
  /// already-resolved element instead of traversing a snapshot backend.
  static func singleElementRead(_ node: RawAXNode) -> PresentedNode {
    PresentedNode(presenting: node)
  }

  private static func presentedNodes(
    from rawNodes: [SnapshotPresentationNode],
    projection: CaptureHint.Projection,
    maximumDepth: Int? = nil
  ) -> [PresentedNode] {
    if projection == .raw {
      return rawNodes.map { PresentedNode(presenting: $0) }
    }

    var nodes: [PresentedNode] = []
    var nearestPresentedNodeByRawIndex: [Int: (index: Int, depth: Int)] = [:]
    for node in rawNodes {
      let raw = node.raw
      let presentedParent = raw.parentIndex.flatMap {
        nearestPresentedNodeByRawIndex[$0]
      }
      guard isEligibleForRegularPresentation(raw) else {
        if let presentedParent {
          nearestPresentedNodeByRawIndex[raw.index] = presentedParent
        }
        continue
      }

      let presentedIndex = nodes.count
      let presentedDepth = presentedParent.map { $0.depth + 1 } ?? 0
      if let maximumDepth, presentedDepth > maximumDepth {
        if let presentedParent {
          nearestPresentedNodeByRawIndex[raw.index] = presentedParent
        }
        continue
      }
      nearestPresentedNodeByRawIndex[raw.index] = (presentedIndex, presentedDepth)
      nodes.append(
        PresentedNode(
          presenting: raw,
          rect: node.effectiveRect,
          index: presentedIndex,
          depth: presentedDepth,
          parentIndex: presentedParent?.index
        )
      )
    }
    return nodes
  }

  private static func applyScope(
    to rawNodes: [SnapshotPresentationNode],
    options: PresentationOptions,
    projection: CaptureHint.Projection
  ) -> [SnapshotPresentationNode] {
    switch SnapshotScopePolicy.select(
      fromPreorder: rawNodes,
      scope: options.scope,
      depth: { $0.raw.depth },
      semanticValues: { [$0.raw.label, $0.raw.identifier, $0.raw.value] },
      subtreeContributes: { range in
        projection == .raw
          || rawNodes[range].contains { isEligibleForRegularPresentation($0.raw) }
      }
    ) {
    case .unscoped:
      return rawNodes
    case .missing:
      return []
    case .matched(let startIndex):
      let startDepth = rawNodes[startIndex].raw.depth
      let range = SnapshotScopePolicy.subtreeRange(
        from: startIndex,
        in: rawNodes,
        depth: { $0.raw.depth }
      )
      let maxDepth = options.depth ?? Int.max
      let scopedNodes = projection == .raw
        ? Array(rawNodes[range]).filter { $0.raw.depth - startDepth <= maxDepth }
        : Array(rawNodes[range])
      return reindex(scopedNodes, depthOffset: startDepth)
    }
  }

  private static func reindex(
    _ nodes: [SnapshotPresentationNode],
    depthOffset: Int
  ) -> [SnapshotPresentationNode] {
    let indexMap = Dictionary(
      uniqueKeysWithValues: nodes.enumerated().map { ($0.element.raw.index, $0.offset) })
    return nodes.enumerated().map { offset, node in
      let raw = node.raw
      return SnapshotPresentationNode(
        raw: RawAXNode(
          index: offset,
          type: raw.type,
          label: raw.label,
          identifier: raw.identifier,
          value: raw.value,
          rect: raw.rect,
          enabled: raw.enabled,
          focused: raw.focused,
          selected: raw.selected,
          hittable: raw.hittable,
          depth: max(0, raw.depth - depthOffset),
          parentIndex: raw.parentIndex.flatMap { indexMap[$0] },
          hiddenContentAbove: raw.hiddenContentAbove,
          hiddenContentBelow: raw.hiddenContentBelow,
          actions: raw.actions
        ),
        effectiveRect: node.effectiveRect
      )
    }
  }

  private static func isEligibleForRegularPresentation(_ node: RawAXNode) -> Bool {
    // The top-level carrier owns viewport geometry and must survive even for query-sweep's
    // deliberately unlabeled synthetic Application node.
    if node.parentIndex == nil { return true }
    return eligibleInteractiveTypes.contains(node.type) || node.hasSemanticContent
  }
}
