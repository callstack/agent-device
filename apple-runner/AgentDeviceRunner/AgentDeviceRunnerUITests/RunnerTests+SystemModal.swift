import XCTest

extension RunnerTests {
  // MARK: - Blocking System Modal Snapshot

  func blockingSystemAlertSnapshot(deadline: Date = .distantFuture) -> DataPayload? {
    #if os(macOS)
      return nil
    #else
    guard let modal = firstBlockingSystemModal(in: springboard, deadline: deadline) else {
      return nil
    }
    let actions = actionableElements(in: modal)
    guard !actions.isEmpty else {
      return nil
    }

    let title = preferredSystemModalTitle(modal)
    guard let modalNode = safeMakeSnapshotNode(
      element: modal,
      index: 0,
      type: "Alert",
      labelOverride: title,
      identifierOverride: modal.identifier,
      depth: 0,
      hittableOverride: true
    ) else {
      return nil
    }
    var nodes: [SnapshotNode] = [modalNode]

    for content in informativeElements(in: modal, excluding: actions) {
      guard let contentNode = safeMakeSnapshotNode(
        element: content,
        index: nodes.count,
        type: elementTypeName(content.elementType),
        depth: 1,
        parentIndex: 0,
        hittableOverride: false
      ) else {
        continue
      }
      nodes.append(contentNode)
    }

    for action in actions {
      guard let actionNode = safeMakeSnapshotNode(
        element: action,
        index: nodes.count,
        type: elementTypeName(action.elementType),
        depth: 1,
        parentIndex: 0,
        hittableOverride: true
      ) else {
        continue
      }
      nodes.append(actionNode)
    }

    return DataPayload(nodes: nodes, truncated: false)
    #endif
  }

  func firstBlockingSystemModal(
    in springboard: XCUIApplication,
    deadline: Date = .distantFuture
  ) -> XCUIElement? {
    let disableSafeProbe = RunnerEnv.isTruthy("AGENT_DEVICE_RUNNER_DISABLE_SAFE_MODAL_PROBE")
    let queryElements: (() -> [XCUIElement]) -> [XCUIElement] = { fetch in
      if disableSafeProbe {
        return fetch()
      }
      return self.safeElementsQuery(fetch)
    }

    let alerts = queryElements {
      springboard.alerts.allElementsBoundByIndex
    }
    for alert in alerts {
      if safeIsBlockingSystemModal(alert, in: springboard) {
        return alert
      }
    }

    // Don't start the second (sheet) enumeration once the shared probe deadline is spent (#1244).
    if Date() >= deadline {
      NSLog("AGENT_DEVICE_RUNNER_SYSTEM_MODAL_PROBE_DEADLINE stage=sheets")
      return nil
    }

    let sheets = queryElements {
      springboard.sheets.allElementsBoundByIndex
    }
    for sheet in sheets {
      if safeIsBlockingSystemModal(sheet, in: springboard) {
        return sheet
      }
    }

    return nil
  }

  func safeElementsQuery(_ fetch: () -> [XCUIElement]) -> [XCUIElement] {
    safely("MODAL_QUERY", [], fetch)
  }

  private func safeIsBlockingSystemModal(_ element: XCUIElement, in springboard: XCUIApplication) -> Bool {
    safely("MODAL_CHECK", false) { isBlockingSystemModal(element, in: springboard) }
  }

  private func isBlockingSystemModal(_ element: XCUIElement, in springboard: XCUIApplication) -> Bool {
    guard element.exists else { return false }
    let frame = element.frame
    if frame.isNull || frame.isEmpty { return false }

    let viewport = springboard.frame
    if viewport.isNull || viewport.isEmpty { return false }

    let center = CGPoint(x: frame.midX, y: frame.midY)
    if !viewport.contains(center) { return false }

    return true
  }

  func actionableElements(in element: XCUIElement) -> [XCUIElement] {
    var seen = Set<String>()
    var actions: [XCUIElement] = []
    let descendants = actionableTypes.flatMap { modalDescendants(in: element, matching: $0) }
    for candidate in descendants {
      if !safeIsActionableCandidate(candidate, seen: &seen) { continue }
      actions.append(candidate)
    }
    return actions
  }

  private func safeIsActionableCandidate(_ candidate: XCUIElement, seen: inout Set<String>) -> Bool {
    safely("MODAL_ACTION", false) {
      if !candidate.exists || !candidate.isHittable { return false }
      if !actionableTypes.contains(candidate.elementType) { return false }
      let frame = candidate.frame
      if frame.isNull || frame.isEmpty { return false }
      let key = "\(candidate.elementType.rawValue)-\(frame.origin.x)-\(frame.origin.y)-\(frame.size.width)-\(frame.size.height)-\(candidate.label)"
      if seen.contains(key) { return false }
      seen.insert(key)
      return true
    }
  }

  private func informativeElements(in element: XCUIElement, excluding actions: [XCUIElement]) -> [XCUIElement] {
    let actionKeys = Set(actions.map(systemModalElementKey))
    var seen = Set<String>()
    var contents: [XCUIElement] = []
    let descendants = readableSystemModalTypes.flatMap {
      modalDescendants(in: element, matching: $0, limit: 2)
    }
    for candidate in descendants {
      guard let key = safeInformativeElementKey(candidate, actionKeys: actionKeys) else {
        continue
      }
      if seen.contains(key) { continue }
      seen.insert(key)
      contents.append(candidate)
    }
    return contents
  }

  private var readableSystemModalTypes: [XCUIElement.ElementType] {
    [.staticText, .textView]
  }

  private func modalDescendants(
    in element: XCUIElement,
    matching type: XCUIElement.ElementType,
    limit: Int? = nil
  ) -> [XCUIElement] {
    let elements = safeElementsQuery {
      element.descendants(matching: type).allElementsBoundByIndex
    }
    guard let limit else {
      return elements
    }
    return Array(elements.prefix(limit))
  }

  private func safeInformativeElementKey(_ candidate: XCUIElement, actionKeys: Set<String>) -> String? {
    safely("MODAL_CONTENT") { () -> String? in
      let key = systemModalElementKey(candidate)
      if actionKeys.contains(key) { return nil }
      if actionableTypes.contains(candidate.elementType) { return nil }
      if !candidate.exists { return nil }
      let frame = candidate.frame
      if frame.isNull || frame.isEmpty { return nil }
      let label = candidate.label.trimmingCharacters(in: .whitespacesAndNewlines)
      if label.isEmpty { return nil }
      return key
    }
  }

  private func systemModalElementKey(_ element: XCUIElement) -> String {
    let frame = element.frame
    return "\(element.elementType.rawValue)-\(frame.origin.x)-\(frame.origin.y)-\(frame.size.width)-\(frame.size.height)-\(element.label)-\(element.identifier)"
  }

  private func preferredSystemModalTitle(_ element: XCUIElement) -> String {
    let label = element.label
    if !label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      return label
    }
    let identifier = element.identifier
    if !identifier.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      return identifier
    }
    return "System Alert"
  }

  private func makeSnapshotNode(
    element: XCUIElement,
    index: Int,
    type: String,
    labelOverride: String? = nil,
    identifierOverride: String? = nil,
    depth: Int,
    parentIndex: Int? = nil,
    hittableOverride: Bool? = nil
  ) -> SnapshotNode {
    let label = (labelOverride ?? element.label).trimmingCharacters(in: .whitespacesAndNewlines)
    let identifier = (identifierOverride ?? element.identifier).trimmingCharacters(in: .whitespacesAndNewlines)
    return SnapshotNode(
      index: index,
      type: type,
      label: label.isEmpty ? nil : label,
      identifier: identifier.isEmpty ? nil : identifier,
      value: nil,
      rect: snapshotRect(from: element.frame),
      enabled: element.isEnabled,
      focused: nil,
      selected: nil,
      hittable: hittableOverride ?? element.isHittable,
      depth: depth,
      parentIndex: parentIndex,
      hiddenContentAbove: nil,
      hiddenContentBelow: nil
    )
  }

  private func safeMakeSnapshotNode(
    element: XCUIElement,
    index: Int,
    type: String,
    labelOverride: String? = nil,
    identifierOverride: String? = nil,
    depth: Int,
    parentIndex: Int? = nil,
    hittableOverride: Bool? = nil
  ) -> SnapshotNode? {
    safely("MODAL_NODE") {
      makeSnapshotNode(
        element: element,
        index: index,
        type: type,
        labelOverride: labelOverride,
        identifierOverride: identifierOverride,
        depth: depth,
        parentIndex: parentIndex,
        hittableOverride: hittableOverride
      )
    }
  }
}
