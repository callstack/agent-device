import XCTest

struct FlatSnapshotFilterNode {
  let isRoot: Bool
  let label: String
  let identifier: String
  let valueText: String?
  let visible: Bool

  func matchesScope(_ scope: String) -> Bool {
    let haystack = [label, identifier, valueText ?? ""].joined(separator: "\n")
    return haystack.localizedCaseInsensitiveContains(scope)
  }
}

struct FlatSnapshotFilterDecision {
  let include: Bool
  let insideMatchedScope: Bool
}

extension RunnerTests {
  func flatSnapshotFilterDecision(
    _ node: FlatSnapshotFilterNode,
    options: SnapshotOptions,
    insideMatchedScope: Bool
  ) -> FlatSnapshotFilterDecision {
    let scope = options.scope?.trimmingCharacters(in: .whitespacesAndNewlines)
    let scopeActive = scope?.isEmpty == false
    let matchesScope: Bool
    if scopeActive, let scope {
      matchesScope = node.matchesScope(scope)
    } else {
      matchesScope = false
    }
    let nowInsideScope = insideMatchedScope || matchesScope

    let include: Bool
    if node.isRoot {
      include = true
    } else if scopeActive && !nowInsideScope {
      include = false
    } else if options.interactiveOnly && !node.visible {
      include = false
    } else {
      include = true
    }

    return FlatSnapshotFilterDecision(include: include, insideMatchedScope: nowInsideScope)
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
  func testFlatSnapshotFilterDecisionMatrixCoversOptions() {
    let visibleContent = FlatSnapshotFilterNode(
      isRoot: false,
      label: "Welcome back",
      identifier: "",
      valueText: nil,
      visible: true
    )
    let hiddenInteractive = FlatSnapshotFilterNode(
      isRoot: false,
      label: "Hidden menu",
      identifier: "",
      valueText: nil,
      visible: false
    )
    let decorative = FlatSnapshotFilterNode(
      isRoot: false,
      label: "",
      identifier: "",
      valueText: nil,
      visible: true
    )

    XCTAssertTrue(
      flatSnapshotFilterDecision(
        visibleContent,
        options: SnapshotOptions(interactiveOnly: false, depth: nil, scope: nil, raw: false),
        insideMatchedScope: false
      ).include
    )
    XCTAssertFalse(
      flatSnapshotFilterDecision(
        hiddenInteractive,
        options: SnapshotOptions(interactiveOnly: true, depth: nil, scope: nil, raw: false),
        insideMatchedScope: false
      ).include
    )
    XCTAssertTrue(
      flatSnapshotFilterDecision(
        decorative,
        options: SnapshotOptions(interactiveOnly: false, depth: nil, scope: nil, raw: false),
        insideMatchedScope: false
      ).include
    )
    XCTAssertTrue(
      flatSnapshotFilterDecision(
        decorative,
        options: SnapshotOptions(interactiveOnly: false, depth: nil, scope: nil, raw: false),
        insideMatchedScope: false
      ).include
    )
  }

  func testFlatSnapshotFilterDecisionCarriesSubtreeScopeState() {
    let scopeRoot = FlatSnapshotFilterNode(
      isRoot: false,
      label: "",
      identifier: "homeScreen",
      valueText: nil,
      visible: true
    )
    let unmatchedDescendant = FlatSnapshotFilterNode(
      isRoot: false,
      label: "Post body without the scope text",
      identifier: "",
      valueText: nil,
      visible: true
    )
    let options = SnapshotOptions(interactiveOnly: false, depth: nil, scope: "homeScreen", raw: false)

    let rootDecision = flatSnapshotFilterDecision(
      scopeRoot,
      options: options,
      insideMatchedScope: false
    )
    XCTAssertTrue(rootDecision.include)
    XCTAssertTrue(rootDecision.insideMatchedScope)

    XCTAssertTrue(
      flatSnapshotFilterDecision(
        unmatchedDescendant,
        options: options,
        insideMatchedScope: rootDecision.insideMatchedScope
      ).include
    )
    XCTAssertFalse(
      flatSnapshotFilterDecision(
        unmatchedDescendant,
        options: options,
        insideMatchedScope: false
      ).include
    )
  }

  func testPrivateAXInteractiveCandidatesPreserveBackendInputs() {
    XCTAssertTrue(
      privateAXInteractiveCandidate(rawElementType: Int(XCUIElement.ElementType.scrollView.rawValue)),
      "private AX marks scroll containers as interactive candidates"
    )
  }
#endif
}
