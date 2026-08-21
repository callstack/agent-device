import Foundation

/// Backend-owned snapshot output before it crosses the presentation seam.
///
/// The incremental #1797 migration still carries derived fields that later semantic layers move
/// behind `SnapshotPresentation`. Eligibility is no longer one of those backend-owned decisions.
struct RawAXNode {
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
  var actions: [String]? = nil
}

/// The acquisition-facing view of a snapshot request, derived once by
/// `SnapshotPresentation.captureHint(for:)`.
///
/// Backends read a hint, never `PresentationOptions`: presentation owns interpretation, and a hint
/// may narrow acquisition only where the backend can prove the narrowing complete for the requested
/// projection (#1797 conservatism). Everything else a hint carries is budget and ordering.
struct CaptureHint {
  /// Which projection this acquisition must serve. Backends that cannot serve one are not planned
  /// for it (`SnapshotBackendKind.supportsRawProjection`), and presentation refuses an acquisition
  /// captured for the other projection rather than relabeling it, so a `--raw` request can never be
  /// answered with regular-projection membership (#1797 D4).
  enum Projection: String {
    case regular
    case raw
  }

  let projection: Projection
  /// Traversal-depth budget.
  ///
  /// Declared residue (#1797): complete for the raw projection, whose presented depth *is*
  /// traversal depth. Regular presentation emits collapsed depth, so cutting the traversal at this
  /// limit can still drop a node that would have presented within it — the open "visible-depth
  /// frontier completeness" obligation, kept as-is here because the cut is also what keeps
  /// `--depth 1` probes cheap.
  let depth: Int?
  /// Regular-projection acquisition budget. The raw projection is the acquired tree, so it never
  /// carries this: `--raw -i` returns everything the backend serialized.
  let interactiveOnly: Bool
  let customActions: Bool

  var isRaw: Bool { projection == .raw }
}

/// One backend attempt after acquisition and its current backend-specific interpretation.
///
/// It is the only input snapshot presentation accepts, and it carries the hint it was captured
/// under so the two sides of the seam cannot disagree about which projection this is. Later #1797
/// steps move the interpretation that still precedes this value — the clip fold and hittability —
/// into `SnapshotPresentation` without changing the capture-plan seam.
struct SnapshotAcquisition {
  /// The hint this acquisition was captured under. Presentation compares it with the requested
  /// projection instead of trusting the backend's label.
  let hint: CaptureHint
  let nodes: [RawAXNode]
  let truncated: Bool
  let effectiveDepth: Int?
  var customActions: SnapshotCustomActionCoverage? = nil
  /// Viewport the regular projection's clip fold runs against. `.infinite` disables the fold --
  /// legitimate only for raw acquisitions and depth-0 probes, where no fold applies.
  var viewport: CGRect = .infinite
}

/// Platform policy for the regular projection's visibility fold (#1797: macOS is a policy input
/// to the shared algorithm, never a backend exception).
enum SnapshotFoldPolicy {
  /// iOS: ancestor projection cursor -- an out-of-clip Cell or scroll container hides the
  /// descendants whose clamped frames would otherwise leak back into the viewport -- plus the
  /// sub-pixel decoration rule.
  case cursorProjected
  /// macOS / tvOS: plain viewport intersection per node, no ancestor cursor, and interactive-only
  /// requests additionally drop out-of-viewport Window carriers.
  case plainViewport

  static var platformDefault: SnapshotFoldPolicy {
    #if os(iOS)
      return .cursorProjected
    #else
      return .plainViewport
    #endif
  }
}

/// The only snapshot node shape accepted by response payload assembly.
///
/// Its initializer is private so a backend cannot bypass `SnapshotPresentation`. The encoded shape
/// intentionally remains byte-for-byte compatible with the former `SnapshotNode` wire model.
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
      index: raw.index,
      depth: raw.depth,
      parentIndex: raw.parentIndex
    )
  }

  fileprivate init(presenting raw: RawAXNode, index: Int, depth: Int, parentIndex: Int?) {
    self.index = index
    type = raw.type
    label = raw.label
    identifier = raw.identifier
    value = raw.value
    rect = raw.rect
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

enum SnapshotPresentation {
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
  ) -> SnapshotBackendCapture? {
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
      return presentRegular(acquisition, options: options)
    case .raw:
      return presentRaw(acquisition, options: options)
    }
  }

  /// Visible projection: the clip fold (viewport ∩ scroll clip, ancestor cursor, scroll hints),
  /// eligibility (an interactive type or non-empty semantic content, below the root carrier), and
  /// scope. The only interpreter of what a screen currently shows -- no backend folds its own
  /// visibility (#1797).
  static func presentRegular(
    _ acquisition: SnapshotAcquisition,
    options: PresentationOptions,
    policy: SnapshotFoldPolicy = .platformDefault
  ) -> SnapshotBackendCapture {
    project(
      foldRegularVisibility(
        acquisition.nodes,
        viewport: acquisition.viewport,
        interactiveOnly: options.interactiveOnly,
        policy: policy
      ),
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
    project(acquisition.nodes, acquisition: acquisition, options: options, projection: .raw)
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
      depth: scoped ? nil : options.depth,
      interactiveOnly: projection == .raw ? false : options.interactiveOnly,
      customActions: options.customActions
    )
  }

  private static func project(
    _ projectionNodes: [RawAXNode],
    acquisition: SnapshotAcquisition,
    options: PresentationOptions,
    projection: CaptureHint.Projection
  ) -> SnapshotBackendCapture {
    let scopedRawNodes = applyScope(to: projectionNodes, options: options, projection: projection)
    let nodes = presentedNodes(from: scopedRawNodes, projection: projection)
    let qualityPayload: DataPayload? = SnapshotScopePolicy.isActive(options.scope)
      ? DataPayload(
        nodes: presentedNodes(from: projectionNodes, projection: projection),
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

  /// A decoration this small carries no information a user could act on: sub-pixel separators and
  /// spacer views. Content-carrying nodes are exempt regardless of size.
  private static let negligibleDecorationTolerance = 1.0
  private static let visibilityExemptCarrierTypes: Set<String> = ["Application", "Window"]

  /// The regular projection's clip fold -- the ONE visibility interpreter for every backend
  /// (#1797). Consumes reported facts (frames at raw traversal depth), drops out-of-clip and
  /// negligible-decoration nodes, reparents survivors to their nearest kept ancestor with
  /// collapsed depth, books scroll hints onto the anchors that hide the dropped content, and
  /// narrows `hittable` to the clip: a node outside its clip -- or with no geometry at all --
  /// is never actionable, whatever the backend reported.
  static func foldRegularVisibility(
    _ nodes: [RawAXNode],
    viewport: CGRect,
    interactiveOnly: Bool,
    policy: SnapshotFoldPolicy
  ) -> [RawAXNode] {
    struct BranchState {
      let cursor: FlatSnapshotProjectionCursor
      let anchor: (index: Int, rect: CGRect)?
      let keptIndex: Int?
      let keptDepth: Int
    }

    var hasChildren = [Bool](repeating: false, count: nodes.count)
    for node in nodes {
      if let parentIndex = node.parentIndex, parentIndex >= 0, parentIndex < nodes.count {
        hasChildren[parentIndex] = true
      }
    }

    var states = [BranchState?](repeating: nil, count: nodes.count)
    var kept: [RawAXNode] = []
    var hints: [Int: (above: Bool, below: Bool)] = [:]

    for (offset, node) in nodes.enumerated() {
      let parentState = node.parentIndex.flatMap { states[$0] }
      let parentCursor = parentState?.cursor ?? .root
      let parentAnchor = parentState?.anchor
      let rect = CGRect(
        x: node.rect.x, y: node.rect.y, width: node.rect.width, height: node.rect.height
      )
      let intersects = RunnerTests.isVisibleInRegularSnapshot(
        rect,
        viewport: viewport,
        scrollContainerAnchor: parentAnchor
      )

      let transition: FlatSnapshotProjectionTransition
      switch policy {
      case .cursorProjected:
        transition = RunnerTests.flatSnapshotProjectionTransition(
          frame: rect,
          intersectsViewportAndScrollClip: intersects,
          typeName: node.type,
          hasChildren: hasChildren[offset],
          cursor: parentCursor
        )
      case .plainViewport:
        transition = FlatSnapshotProjectionTransition(
          decision: FlatSnapshotProjectionDecision(
            presentationVisible: intersects,
            descendants: .root
          ),
          hiddenContentFrame: !intersects ? rect : nil
        )
      }

      let negligibleDecoration = policy == .cursorProjected
        && node.parentIndex != nil
        && !hasSemanticContent(node)
        && (rect.isEmpty
          || rect.width <= Self.negligibleDecorationTolerance
          || rect.height <= Self.negligibleDecorationTolerance)
      let visible = transition.decision.presentationVisible && !negligibleDecoration

      let include: Bool
      if node.parentIndex == nil {
        include = true
      } else {
        switch policy {
        case .cursorProjected:
          include = visibilityExemptCarrierTypes.contains(node.type) || visible
        case .plainViewport:
          if interactiveOnly && !visible && node.type != "Application" {
            include = false
          } else {
            include = visibilityExemptCarrierTypes.contains(node.type) || visible
          }
        }
      }

      if let hiddenFrame = transition.hiddenContentFrame, let parentAnchor {
        RunnerTests.rememberHiddenContentHint(
          for: hiddenFrame,
          relativeTo: parentAnchor,
          hints: &hints
        )
      }

      var keptIndex = parentState?.keptIndex
      var keptDepth = parentState?.keptDepth ?? -1
      if include {
        let outIndex = kept.count
        let outDepth = keptDepth + 1
        kept.append(
          RawAXNode(
            index: outIndex,
            type: node.type,
            label: node.label,
            identifier: node.identifier,
            value: node.value,
            rect: node.rect,
            enabled: node.enabled,
            focused: node.focused,
            selected: node.selected,
            hittable: node.hittable && intersects,
            depth: outDepth,
            parentIndex: keptIndex,
            hiddenContentAbove: node.hiddenContentAbove,
            hiddenContentBelow: node.hiddenContentBelow,
            actions: node.actions
          )
        )
        keptIndex = outIndex
        keptDepth = outDepth
      }

      var anchor = parentAnchor
      if include,
        let newAnchor = RunnerTests.scrollContainerAnchor(
          forTypeName: node.type,
          hasChildren: hasChildren[offset],
          visible: intersects,
          frame: rect,
          nodeIndex: keptIndex
        )
      {
        anchor = newAnchor
      }
      states[offset] = BranchState(
        cursor: transition.decision.descendants,
        anchor: anchor,
        keptIndex: keptIndex,
        keptDepth: keptDepth
      )
    }
    return RunnerTests.applyHiddenContentHints(hints, to: kept)
  }

  /// Explicit carve-out for selector queries and system-modal reads that intentionally return one
  /// already-resolved element instead of traversing a snapshot backend.
  static func singleElementRead(_ node: RawAXNode) -> PresentedNode {
    PresentedNode(presenting: node)
  }

  private static func presentedNodes(
    from rawNodes: [RawAXNode],
    projection: CaptureHint.Projection
  ) -> [PresentedNode] {
    if projection == .raw {
      return rawNodes.map(PresentedNode.init(presenting:))
    }

    var nodes: [PresentedNode] = []
    var nearestPresentedNodeByRawIndex: [Int: (index: Int, depth: Int)] = [:]
    for raw in rawNodes {
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
      nearestPresentedNodeByRawIndex[raw.index] = (presentedIndex, presentedDepth)
      nodes.append(
        PresentedNode(
          presenting: raw,
          index: presentedIndex,
          depth: presentedDepth,
          parentIndex: presentedParent?.index
        )
      )
    }
    return nodes
  }

  private static func applyScope(
    to rawNodes: [RawAXNode],
    options: PresentationOptions,
    projection: CaptureHint.Projection
  ) -> [RawAXNode] {
    switch SnapshotScopePolicy.select(
      fromPreorder: rawNodes,
      scope: options.scope,
      depth: \.depth,
      semanticValues: { [$0.label, $0.identifier, $0.value] },
      subtreeContributes: { range in
        projection == .raw || rawNodes[range].contains(where: isEligibleForRegularPresentation)
      }
    ) {
    case .unscoped:
      return rawNodes
    case .missing:
      return []
    case .matched(let startIndex):
      let startDepth = rawNodes[startIndex].depth
      let range = SnapshotScopePolicy.subtreeRange(
        from: startIndex,
        in: rawNodes,
        depth: \.depth
      )
      let maxDepth = options.depth ?? Int.max
      return reindex(
        Array(rawNodes[range]).filter { $0.depth - startDepth <= maxDepth },
        depthOffset: startDepth
      )
    }
  }

  private static func reindex(_ rawNodes: [RawAXNode], depthOffset: Int) -> [RawAXNode] {
    let indexMap = Dictionary(uniqueKeysWithValues: rawNodes.enumerated().map { ($0.element.index, $0.offset) })
    return rawNodes.enumerated().map { offset, raw in
      RawAXNode(
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
      )
    }
  }

  private static func isEligibleForRegularPresentation(_ node: RawAXNode) -> Bool {
    // The top-level carrier owns viewport geometry and must survive even for query-sweep's
    // deliberately unlabeled synthetic Application node.
    if node.parentIndex == nil { return true }
    return eligibleInteractiveTypes.contains(node.type) || hasSemanticContent(node)
  }

  private static func hasSemanticContent(_ node: RawAXNode) -> Bool {
    [node.label, node.identifier, node.value].contains { value in
      guard let value else { return false }
      return !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
  }
}
