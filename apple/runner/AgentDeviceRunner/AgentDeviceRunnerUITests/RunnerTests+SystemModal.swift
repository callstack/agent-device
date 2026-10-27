import XCTest
import AgentDeviceSnapshotPresentation

extension RunnerTests {
  // MARK: - Blocking System Modal Snapshot

  func blockingSystemAlertSnapshot(options: PresentationOptions, deadline: Date = .distantFuture) throws -> DataPayload? {
    #if os(macOS)
      return nil
    #else
    guard case .resolved(let resolvedModal) = resolveBlockingSystemModal(deadline: deadline) else {
      return nil
    }
    return try snapshotForBlockingSystemModal(resolvedModal, options: options, deadline: deadline)
    #endif
  }

  func snapshotForBlockingSystemModal(
    _ resolvedModal: ResolvedBlockingSystemModal,
    options: PresentationOptions = PresentationOptions(interactiveOnly: false, depth: nil, scope: nil, raw: false),
    deadline: Date = .distantFuture
  ) throws -> DataPayload? {
    let modal = resolvedModal.root
    let actions = resolvedModal.actions

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
    var nodes: [RawAXNode] = [modalNode]

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

    // Action controls are the interaction contract. Informative text is useful context, but
    // must not make a usable modal miss the bounded system-modal probe deadline.
    let contentDeadline = deadline.addingTimeInterval(-0.5)
    for content in informativeElements(in: modal, deadline: contentDeadline) {
      guard Date() < contentDeadline,
            let contentNode = safeMakeSnapshotNode(
              element: content,
              index: nodes.count,
              type: elementTypeName(content.elementType),
              depth: 1,
              parentIndex: 0,
              hittableOverride: false
            )
      else {
        break
      }
      nodes.append(contentNode)
    }

    // The probe resolved a blocking modal over the app, so this payload states its own subject rather
    // than leaving a reader to infer it from a tree that holds only the modal (#3565).
    return try Self.blockingSystemModalPayload(nodes: nodes, options: options)
  }

  /// The payload a resolved blocking system modal publishes: the modal's own tree, and the fact that
  /// the modal is what it describes. The probe is the one capture that states `presented` without
  /// reading a window structure — its tree holds only the modal, so nothing downstream could read the
  /// presentation out of it (#3565). Split from the probe body because that body needs a device.
  static func blockingSystemModalPayload(
    nodes: [RawAXNode],
    options: PresentationOptions = PresentationOptions(interactiveOnly: false, depth: nil, scope: nil, raw: false)
  ) throws -> DataPayload {
    let acquisition = SnapshotAcquisition(
      hint: SnapshotPresentation.captureHint(for: options),
      nodes: nodes,
      truncated: false,
      effectiveDepth: nil,
      viewport: nodes.first.map { .derived(box: $0.rect.cgRect) } ?? .missing(reason: .notProvided)
    )
    let result = options.raw
      ? SnapshotPresentation.presentRaw(acquisition, options: options)
      : try SnapshotPresentation.presentRegular(acquisition, options: options, policy: .cursorProjected)
    return DataPayload(
      nodes: result.nodes,
      truncated: false,
      qualityPayload: result.qualityNodes.map { SnapshotQualityPayload(nodes: $0, truncated: false) },
      snapshotQualityNotes: result.qualityNotes.isEmpty ? nil : result.qualityNotes,
      presentedSurface: .presented
    )
  }

  /// A SpringBoard modal and the window that hosts it. A foldable's SpringBoard has windows on
  /// each panel, and `springboard.frame` names only one of them, so the modal is placed against
  /// its own window and its activation is routed through that window's display.
  struct SpringBoardModal {
    let root: XCUIElement
    let window: XCUIElement
  }

  func firstBlockingSystemModal(
    in springboard: XCUIApplication,
    deadline: Date = .distantFuture
  ) -> SpringBoardModal? {
    if let alert = firstBlockingSystemModal(in: springboard, matching: .alert, deadline: deadline) {
      return alert
    }

    // Don't start the second (sheet) enumeration once the shared probe deadline is spent (#1244).
    if Date() >= deadline {
      NSLog("AGENT_DEVICE_RUNNER_SYSTEM_MODAL_PROBE_DEADLINE stage=sheets")
      return nil
    }

    return firstBlockingSystemModal(in: springboard, matching: .sheet, deadline: deadline)
  }

  private func firstBlockingSystemModal(
    in springboard: XCUIApplication,
    matching type: XCUIElement.ElementType,
    deadline: Date
  ) -> SpringBoardModal? {
    let windows = safeElementsQuery {
      springboard.windows.containing(type, identifier: nil).allElementsBoundByIndex
    }
    for window in windows {
      guard Date() < deadline else { return nil }
      let modals = safeElementsQuery {
        window.descendants(matching: type).allElementsBoundByIndex
      }
      for modal in modals {
        guard Date() < deadline else { return nil }
        if safeIsBlockingSystemModal(modal, in: window) {
          return SpringBoardModal(root: modal, window: window)
        }
      }
    }
    return nil
  }

  func safeElementsQuery(_ fetch: () -> [XCUIElement]) -> [XCUIElement] {
    safely("MODAL_QUERY", [], fetch)
  }

  private func safeIsBlockingSystemModal(_ element: XCUIElement, in window: XCUIElement) -> Bool {
    safely("MODAL_CHECK", false) { isBlockingSystemModal(element, in: window) }
  }

  private func isBlockingSystemModal(_ element: XCUIElement, in window: XCUIElement) -> Bool {
    guard element.exists else { return false }
    let frame = element.frame
    if frame.isNull || frame.isEmpty { return false }

    let viewport = window.frame
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

  private func informativeElements(in element: XCUIElement, deadline: Date) -> [XCUIElement] {
    var seen = Set<String>()
    var contents: [XCUIElement] = []
    for type in readableSystemModalTypes {
      guard Date() < deadline else { break }
      for candidate in modalDescendants(in: element, matching: type, limit: 2) {
        guard Date() < deadline else { return contents }
        guard let key = safeInformativeElementKey(candidate) else { continue }
        if seen.contains(key) { continue }
        seen.insert(key)
        contents.append(candidate)
      }
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

  private func safeInformativeElementKey(_ candidate: XCUIElement) -> String? {
    safely("MODAL_CONTENT") { () -> String? in
      let key = systemModalElementKey(candidate)
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
  ) -> RawAXNode {
    let label = (labelOverride ?? element.label).trimmingCharacters(in: .whitespacesAndNewlines)
    let identifier = (identifierOverride ?? element.identifier).trimmingCharacters(in: .whitespacesAndNewlines)
    let value = element.value.map { String(describing: $0).trimmingCharacters(in: .whitespacesAndNewlines) }
    return RawAXNode(
      index: index,
      type: type,
      label: label.isEmpty ? nil : label,
      identifier: identifier.isEmpty ? nil : identifier,
      value: value.flatMap { $0.isEmpty ? nil : $0 },
      rect: SnapshotRect(element.frame),
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
  ) -> RawAXNode? {
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
