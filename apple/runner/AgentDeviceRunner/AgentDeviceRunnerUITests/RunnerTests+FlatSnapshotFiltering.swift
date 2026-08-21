import XCTest

enum FlatSnapshotGeometry {
  case geometryless
  case framed(intersectsViewportAndScrollClip: Bool)
}

enum FlatSnapshotDescendantVisibility: Equatable {
  case independent
  case owned
}

struct FlatSnapshotProjectionCursor {
  static let root = FlatSnapshotProjectionCursor(ancestorProjectedOut: false)

  private let ancestorProjectedOut: Bool

  var isProjectedOut: Bool { ancestorProjectedOut }

  func project(
    geometry: FlatSnapshotGeometry,
    descendantVisibility: FlatSnapshotDescendantVisibility
  ) -> FlatSnapshotProjectionDecision {
    let nodeProjectedOut: Bool
    switch geometry {
    case .geometryless:
      nodeProjectedOut = false
    case .framed(let intersectsViewportAndScrollClip):
      nodeProjectedOut = !intersectsViewportAndScrollClip
    }
    let presentationVisible = !ancestorProjectedOut && !nodeProjectedOut
    let descendantsProjectedOut = ancestorProjectedOut
      || (nodeProjectedOut && descendantVisibility == .owned)
    return FlatSnapshotProjectionDecision(
      presentationVisible: presentationVisible,
      descendants: FlatSnapshotProjectionCursor(
        ancestorProjectedOut: descendantsProjectedOut
      )
    )
  }
}

struct FlatSnapshotProjectionDecision {
  let presentationVisible: Bool
  let descendants: FlatSnapshotProjectionCursor
}

struct FlatSnapshotProjectionTransition {
  let decision: FlatSnapshotProjectionDecision
  let hiddenContentFrame: CGRect?
}

extension RunnerTests {
  static func flatSnapshotGeometry(
    frame: CGRect,
    intersectsViewportAndScrollClip: Bool
  ) -> FlatSnapshotGeometry {
    if frame.isNull || frame.isEmpty { return .geometryless }
    return .framed(intersectsViewportAndScrollClip: intersectsViewportAndScrollClip)
  }

  /// Wire-name variant: the presentation fold works on `RawAXNode.type` strings, the one node
  /// vocabulary every backend already shares (#1797 — backend-neutral by construction).
  static func flatSnapshotDescendantVisibility(
    typeName: String?,
    hasChildren: Bool
  ) -> FlatSnapshotDescendantVisibility {
    guard hasChildren, let typeName else { return .independent }
    if typeName == "Cell" || Self.scrollContainerTypeNames.contains(typeName) {
      return .owned
    }
    return .independent
  }

  static func flatSnapshotProjectionTransition(
    frame: CGRect,
    intersectsViewportAndScrollClip: Bool,
    typeName: String?,
    hasChildren: Bool,
    cursor: FlatSnapshotProjectionCursor
  ) -> FlatSnapshotProjectionTransition {
    let hasFrame = !frame.isNull && !frame.isEmpty
    return FlatSnapshotProjectionTransition(
      decision: cursor.project(
        geometry: flatSnapshotGeometry(
          frame: frame,
          intersectsViewportAndScrollClip: intersectsViewportAndScrollClip
        ),
        descendantVisibility: flatSnapshotDescendantVisibility(
          typeName: typeName,
          hasChildren: hasChildren
        )
      ),
      hiddenContentFrame: !cursor.isProjectedOut && hasFrame
        && !intersectsViewportAndScrollClip ? frame : nil
    )
  }

  func privateAXInteractiveCandidate(rawElementType: Int) -> Bool {
    guard let type = flatSnapshotElementType(rawElementType: rawElementType) else {
      return false
    }
    return interactiveTypes.contains(type) || Self.scrollContainerTypes.contains(type)
  }

  func flatSnapshotElementType(rawElementType: Int) -> XCUIElement.ElementType? {
    guard let raw = UInt(exactly: rawElementType),
      let type = XCUIElement.ElementType(rawValue: raw)
    else {
      return nil
    }
    return type
  }

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
  /// The fold's string vocabulary must track the XCUIElement type sets it mirrors: a scroll
  /// container renamed or added in one place but not the other silently changes which subtrees
  /// own their descendants' visibility.
  func testScrollContainerTypeNamesMatchElementTypeSet() {
    XCTAssertEqual(
      Self.scrollContainerTypeNames,
      Set(Self.scrollContainerTypes.map(elementTypeName))
    )
    XCTAssertEqual(elementTypeName(.cell), "Cell")
  }

  func testFlatSnapshotProjectionMatchesElementReverseScrollCapture() {
    struct FixtureNode {
      let label: String
      let type: XCUIElement.ElementType
      let frame: CGRect
      let children: [FixtureNode]
    }

    let tableFrame = CGRect(x: 0, y: 152.333, width: 402, height: 659.667)
    let visibleRowFrame = CGRect(x: 0, y: 251.333, width: 402, height: 43.667)
    let offscreenThemeRowFrame = CGRect(x: 0, y: 2044.333, width: 402, height: 44)
    let clampedThemeFrame = CGRect(x: 0, y: 152.333, width: 53, height: 20.333)
    let geometrylessFrame = CGRect.zero
    var visibleLabels: [String] = []
    var hints: [Int: (above: Bool, below: Bool)] = [:]

    func visit(
      _ node: FixtureNode,
      cursor: FlatSnapshotProjectionCursor,
      scrollAnchor: (index: Int, rect: CGRect)?
    ) {
      let intersects = Self.isVisibleInRegularSnapshot(
        node.frame,
        viewport: CGRect(x: 0, y: 0, width: 402, height: 874),
        scrollContainerAnchor: scrollAnchor
      )
      let transition = Self.flatSnapshotProjectionTransition(
        frame: node.frame,
        intersectsViewportAndScrollClip: intersects,
        typeName: elementTypeName(node.type),
        hasChildren: !node.children.isEmpty,
        cursor: cursor
      )
      if transition.decision.presentationVisible { visibleLabels.append(node.label) }
      if let hiddenFrame = transition.hiddenContentFrame, let scrollAnchor {
        Self.rememberHiddenContentHint(
          for: hiddenFrame,
          relativeTo: scrollAnchor,
          hints: &hints
        )
      }
      let nextScrollAnchor = Self.scrollContainerTypes.contains(node.type)
        && transition.decision.presentationVisible
        ? (index: 0, rect: node.frame) : scrollAnchor
      for child in node.children {
        visit(
          child,
          cursor: transition.decision.descendants,
          scrollAnchor: nextScrollAnchor
        )
      }
    }

    let fixture = FixtureNode(
      label: "Table",
      type: .table,
      frame: tableFrame,
      children: [
        FixtureNode(
          label: "Profile Picture",
          type: .cell,
          frame: visibleRowFrame,
          children: [
            FixtureNode(
              label: "Profile semantics",
              type: .staticText,
              frame: geometrylessFrame,
              children: [
                FixtureNode(
                  label: "Profile detail",
                  type: .staticText,
                  frame: visibleRowFrame,
                  children: []
                )
              ]
            )
          ]
        ),
        // Element reports this row at y=2044 but clamps Theme and Auto to the table's top edge.
        FixtureNode(
          label: "Theme row",
          type: .cell,
          frame: offscreenThemeRowFrame,
          children: [
            FixtureNode(
              label: "Theme",
              type: .staticText,
              frame: clampedThemeFrame,
              children: []
            ),
            FixtureNode(
              label: "Auto",
              type: .staticText,
              frame: clampedThemeFrame,
              children: []
            )
          ]
        ),
        FixtureNode(
          label: "Offscreen wrapper",
          type: .other,
          frame: offscreenThemeRowFrame,
          children: [
            FixtureNode(
              label: "Visible overlay",
              type: .staticText,
              frame: visibleRowFrame,
              children: []
            )
          ]
        )
      ]
    )
    visit(fixture, cursor: .root, scrollAnchor: nil)

    XCTAssertEqual(
      visibleLabels,
      ["Table", "Profile Picture", "Profile semantics", "Profile detail", "Visible overlay"]
    )
    XCTAssertEqual(hints.count, 1)
    XCTAssertEqual(hints[0]?.above, false)
    XCTAssertEqual(hints[0]?.below, true)

    let scopedRoot = Self.flatSnapshotProjectionTransition(
      frame: offscreenThemeRowFrame,
      intersectsViewportAndScrollClip: false,
      typeName: "Cell",
      hasChildren: true,
      cursor: .root
    )
    let scopedClampedChild = Self.flatSnapshotProjectionTransition(
      frame: clampedThemeFrame,
      intersectsViewportAndScrollClip: true,
      typeName: "StaticText",
      hasChildren: false,
      cursor: scopedRoot.decision.descendants
    )
    XCTAssertFalse(scopedClampedChild.decision.presentationVisible)
  }

  func testPrivateAXInteractiveCandidatesPreserveBackendInputs() {
    XCTAssertTrue(
      privateAXInteractiveCandidate(rawElementType: Int(XCUIElement.ElementType.scrollView.rawValue)),
      "private AX marks scroll containers as interactive candidates"
    )
  }
#endif
}
