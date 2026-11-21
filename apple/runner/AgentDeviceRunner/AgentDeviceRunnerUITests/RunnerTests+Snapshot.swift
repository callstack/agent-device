import XCTest
import AgentDeviceSnapshotPresentation

extension RunnerTests {
  static let axSnapshotErrorCode = RunnerPassThroughErrorCode.iosAxSnapshotFailed
  static let axSnapshotFailureMessage =
    "iOS XCTest snapshot failed while serializing the accessibility tree."
  static let axSnapshotUnavailableReason = "ax_snapshot_unavailable"
  static let axSnapshotHint =
    "Snapshot state is unavailable because XCTest could not serialize this iOS accessibility tree. This can be specific to the current screen. Use plain screenshot, not screenshot --overlay-refs, as visual truth; navigate with coordinate commands if needed; then retry snapshot -i after reaching another screen. If you own the app and need full-tree inspection, simplify this screen's accessibility tree and expose stable ids on actionable controls."
  static let rawSnapshotTooLargeCode = RunnerPassThroughErrorCode.iosRawSnapshotTooLarge
  static let rawSnapshotMaxNodes = 5_000
  static let rawSnapshotTooLargeHint =
    "Raw iOS snapshot exceeded the runner payload guard. Use regular snapshot for visible UI, or scope/depth-limit raw snapshot when inspecting a large accessibility tree."
  // Runaway guard for the regular tree walk: a work bound only. A screen that trips it raises this
  // number in ADR 0004's name rather than bounding the walk by geometry again.
  private static let regularSnapshotMaxNodes = 50_000
  private static let regularSnapshotTooLargeCode = RunnerPassThroughErrorCode.iosSnapshotTooLarge
  private static let regularSnapshotTooLargeHint =
    "iOS snapshot walked an unexpectedly large accessibility tree. Scope the snapshot to a subtree or use screenshot."
  struct SnapshotTraversalContext {
    let queryRoot: XCUIElement
    let rootSnapshot: XCUIElementSnapshot
    /// How long reading `rootSnapshot` took: what one more query over the whole app is expected to cost.
    let rootReadDuration: TimeInterval
    /** Carries which way the app's interface is turned from the device's native space (#2612). */
    let viewport: SnapshotViewport
    /**
     * The keyboard band this capture measured, published beside the tree so the daemon's tap guard
     * measures against the producer's own reading rather than a band it derives from these rects
     * (#2660). Nil only where the platform has no iOS keyboard to measure.
     */
    let keyboardBand: RunnerKeyboardBandFact?
    /// The lit panel's window the request booked; set only on a multi-panel request (ADR 0025).
    var litPanelSurface: LitPanelSurface? = nil
  }

  struct SnapshotEvaluation {
    let label: String
    let identifier: String
    let valueText: String?
    let placeholder: String?
    let focused: Bool
    let selected: Bool
  }

  private struct SnapshotTraversalEntry {
    let snapshot: XCUIElementSnapshot
    let depth: Int
    let parentIndex: Int?
  }

  /// The acquisition work bound for a tree walk: raw traversal depth only. A regular capture carries
  /// no raw bound, so it walks the whole materialized tree and `SnapshotPresentation` does the
  /// presented-depth cut and the visibility fold on the normalized array. An acquisition bound must
  /// not read geometry: consulting the fold mid-walk was how a turned keyboard subtree got pruned by
  /// its un-normalized rect under `--depth` (#2612, #2661).
  static func canDescendAtRawDepth(_ depth: Int, hint: CaptureHint) -> Bool {
    guard let rawLimit = hint.rawTraversalDepth else { return true }
    return depth < rawLimit
  }

  struct SnapshotCaptureFailure: Error {
    let code: String
    let message: String
    let hint: String
    let qualityReasonCode: String?

    init(code: String, message: String, hint: String, qualityReasonCode: String? = nil) {
      self.code = code
      self.message = message
      self.hint = hint
      self.qualityReasonCode = qualityReasonCode
    }
  }

  // MARK: - Snapshot Entry

  /**
   * Every element-type name a capture can carry, keyed by the raw value the SDK numbers it with. The
   * golden table `contracts/fixtures/ios-element-type-names.json` holds the same rows, and the
   * Simulator AX bridge mirrors them by index in `ELEMENT_TYPE_NAMES`
   * (`packages/platform-apple/src/snapshot-source/tree.ts`), so one node carries one `type` whichever
   * producer served it (#4657). `RunnerTests+ElementTypeNamesTests` reads that table through this
   * dictionary and fails when a row names a raw value differently here.
   *
   * One table serves every runner platform, so a macOS, tvOS, visionOS or watchOS capture publishes
   * these names too: the numbers and the names come from the same SDK header on all of them. The
   * presented-surface rule still reads the raw-value spelling, so a consumer of a capture from an
   * older runner keeps working.
   *
   * A row keyed by an SDK case cannot drift from the number: the case names the number. The two rows
   * keyed by a bare number cover the SDK-hidden Keyboard and Key values, whose numbers the table owns.
   */
  static let elementTypeNamesByRawValue: [UInt: String] = [
    XCUIElement.ElementType.any.rawValue: "Other",
    XCUIElement.ElementType.other.rawValue: "Other",
    XCUIElement.ElementType.application.rawValue: "Application",
    XCUIElement.ElementType.group.rawValue: "Group",
    XCUIElement.ElementType.window.rawValue: "Window",
    XCUIElement.ElementType.sheet.rawValue: "Sheet",
    XCUIElement.ElementType.drawer.rawValue: "Drawer",
    XCUIElement.ElementType.alert.rawValue: "Alert",
    XCUIElement.ElementType.dialog.rawValue: "Dialog",
    XCUIElement.ElementType.button.rawValue: "Button",
    XCUIElement.ElementType.radioButton.rawValue: "RadioButton",
    XCUIElement.ElementType.radioGroup.rawValue: "RadioGroup",
    XCUIElement.ElementType.checkBox.rawValue: "CheckBox",
    XCUIElement.ElementType.disclosureTriangle.rawValue: "DisclosureTriangle",
    XCUIElement.ElementType.popUpButton.rawValue: "PopUpButton",
    XCUIElement.ElementType.comboBox.rawValue: "ComboBox",
    XCUIElement.ElementType.menuButton.rawValue: "MenuButton",
    XCUIElement.ElementType.toolbarButton.rawValue: "ToolbarButton",
    XCUIElement.ElementType.popover.rawValue: "Popover",
    19: "Keyboard",
    20: "Key",
    XCUIElement.ElementType.navigationBar.rawValue: "NavigationBar",
    XCUIElement.ElementType.tabBar.rawValue: "TabBar",
    XCUIElement.ElementType.tabGroup.rawValue: "TabGroup",
    XCUIElement.ElementType.toolbar.rawValue: "Toolbar",
    XCUIElement.ElementType.statusBar.rawValue: "StatusBar",
    XCUIElement.ElementType.table.rawValue: "Table",
    XCUIElement.ElementType.tableRow.rawValue: "TableRow",
    XCUIElement.ElementType.tableColumn.rawValue: "TableColumn",
    XCUIElement.ElementType.outline.rawValue: "Outline",
    XCUIElement.ElementType.outlineRow.rawValue: "OutlineRow",
    XCUIElement.ElementType.browser.rawValue: "Browser",
    XCUIElement.ElementType.collectionView.rawValue: "CollectionView",
    XCUIElement.ElementType.slider.rawValue: "Slider",
    XCUIElement.ElementType.pageIndicator.rawValue: "PageIndicator",
    XCUIElement.ElementType.progressIndicator.rawValue: "ProgressIndicator",
    XCUIElement.ElementType.activityIndicator.rawValue: "ActivityIndicator",
    XCUIElement.ElementType.segmentedControl.rawValue: "SegmentedControl",
    XCUIElement.ElementType.picker.rawValue: "Picker",
    XCUIElement.ElementType.pickerWheel.rawValue: "PickerWheel",
    XCUIElement.ElementType.switch.rawValue: "Switch",
    XCUIElement.ElementType.toggle.rawValue: "Toggle",
    XCUIElement.ElementType.link.rawValue: "Link",
    XCUIElement.ElementType.image.rawValue: "Image",
    XCUIElement.ElementType.icon.rawValue: "Icon",
    XCUIElement.ElementType.searchField.rawValue: "SearchField",
    XCUIElement.ElementType.scrollView.rawValue: "ScrollView",
    XCUIElement.ElementType.scrollBar.rawValue: "ScrollBar",
    XCUIElement.ElementType.staticText.rawValue: "StaticText",
    XCUIElement.ElementType.textField.rawValue: "TextField",
    XCUIElement.ElementType.secureTextField.rawValue: "SecureTextField",
    XCUIElement.ElementType.datePicker.rawValue: "DatePicker",
    XCUIElement.ElementType.textView.rawValue: "TextView",
    XCUIElement.ElementType.menu.rawValue: "Menu",
    XCUIElement.ElementType.menuItem.rawValue: "MenuItem",
    XCUIElement.ElementType.menuBar.rawValue: "MenuBar",
    XCUIElement.ElementType.menuBarItem.rawValue: "MenuBarItem",
    XCUIElement.ElementType.map.rawValue: "Map",
    XCUIElement.ElementType.webView.rawValue: "WebView",
    XCUIElement.ElementType.incrementArrow.rawValue: "IncrementArrow",
    XCUIElement.ElementType.decrementArrow.rawValue: "DecrementArrow",
    XCUIElement.ElementType.timeline.rawValue: "Timeline",
    XCUIElement.ElementType.ratingIndicator.rawValue: "RatingIndicator",
    XCUIElement.ElementType.valueIndicator.rawValue: "ValueIndicator",
    XCUIElement.ElementType.splitGroup.rawValue: "SplitGroup",
    XCUIElement.ElementType.splitter.rawValue: "Splitter",
    XCUIElement.ElementType.relevanceIndicator.rawValue: "RelevanceIndicator",
    XCUIElement.ElementType.colorWell.rawValue: "ColorWell",
    XCUIElement.ElementType.helpTag.rawValue: "HelpTag",
    XCUIElement.ElementType.matte.rawValue: "Matte",
    XCUIElement.ElementType.dockItem.rawValue: "DockItem",
    XCUIElement.ElementType.ruler.rawValue: "Ruler",
    XCUIElement.ElementType.rulerMarker.rawValue: "RulerMarker",
    XCUIElement.ElementType.grid.rawValue: "Grid",
    XCUIElement.ElementType.levelIndicator.rawValue: "LevelIndicator",
    XCUIElement.ElementType.cell.rawValue: "Cell",
    XCUIElement.ElementType.layoutArea.rawValue: "LayoutArea",
    XCUIElement.ElementType.layoutItem.rawValue: "LayoutItem",
    XCUIElement.ElementType.handle.rawValue: "Handle",
    XCUIElement.ElementType.stepper.rawValue: "Stepper",
    XCUIElement.ElementType.tab.rawValue: "Tab",
    XCUIElement.ElementType.touchBar.rawValue: "TouchBar",
    XCUIElement.ElementType.statusItem.rawValue: "StatusItem"
  ]

  /// The name this producer publishes for an element type, and the raw-value spelling for one no row
  /// names — which stays the only way an unseen number reaches a snapshot.
  func elementTypeName(_ type: XCUIElement.ElementType) -> String {
    Self.elementTypeNamesByRawValue[type.rawValue] ?? "Element(\(type.rawValue))"
  }

  static let structuralOnlyNodeTypes: Set<String> = [
    "Application",
    "Window",
    "Other",
    "ScrollView"
  ]

  static let collapsedTabCandidateTypes: Set<XCUIElement.ElementType> = [
    .button,
    .link,
    .menuItem,
    .other,
    .staticText
  ]

  static let scrollContainerTypes: Set<XCUIElement.ElementType> = [
    .collectionView,
    .scrollView,
    .table
  ]

  static let flatInteractiveFallbackBudget: TimeInterval = 1.0
  /// The least slice time a sweep query may start with. XCTest cannot cancel a query, so one that
  /// starts later outlives the slice its caller waits for and holds the main thread (#2783).
  static let flatInteractiveQueryBudget: TimeInterval = 0.1

  /// The deadline the query-sweep tier's caller waits for: one slice, clamped to the plan deadline.
  /// Interactive and non-interactive requests share it, since the caller discards a later result.
  static func querySweepSliceDeadline(startedAt: Date, planDeadline: Date) -> Date {
    min(startedAt.addingTimeInterval(flatInteractiveFallbackBudget), planDeadline)
  }

  /// Whether a query started at `now` and expected to take `expectedCost` can still finish before
  /// `deadline`. XCTest cannot cancel a query once it starts; the least admitted cost is a sweep
  /// query's.
  static func xctestQueryCanStart(deadline: Date, now: Date, expectedCost: TimeInterval = 0) -> Bool {
    deadline.timeIntervalSince(now) >= max(flatInteractiveQueryBudget, expectedCost)
  }

  /// What one capture may spend reading the keyboard band before it gives up on the fact and lets the
  /// tap guard fall back to the tree rule. The scroll path pays this query per gesture and stays well
  /// inside a second; the number here is a ceiling for a read that normally returns in milliseconds,
  /// sized so a hostile keyboard surface cannot extend a capture the way the unbounded read it
  /// replaced would have (#2660).
  static let keyboardBandProbeBudget: TimeInterval = 0.3

  // The single production entry point -- always compiled, no unit-test overload. A unit test
  // exercises this exact function; the only injectable seam lives inside
  // `boundedBlockingSystemAlertSnapshot`'s probe closure (see `systemModalProbeOverrideForTesting`
  // in RunnerTests.swift), so reverting this entry point to bypass the bounded probe fails the
  // regression test.
  func snapshotFast(target: SnapshotCaptureTarget, options: PresentationOptions) throws -> DataPayload {
    try snapshotAfterSystemAlertTier(
      plan: Self.regularVisiblePlan,
      terminal: .sparseWithFatalOnAXFailure,
      target: target,
      options: options
    )
  }

  @MainActor
  func recursiveTreeSnapshotAcquisition(
    context: SnapshotTraversalContext,
    hint: CaptureHint,
    processingDeadline: Date
  ) throws -> (acquisition: SnapshotAcquisition, outcome: SnapshotTierOutcome) {
    var outcome = SnapshotTierOutcome.completed
    var cachedCollapsedTabCandidates: [CollapsedTabCandidate]?
    func collapsedTabCandidatesOnce() throws -> [CollapsedTabCandidate] {
      if let cachedCollapsedTabCandidates {
        return cachedCollapsedTabCandidates
      }
      let candidates = try collapsedTabCandidates(context: context, processingDeadline: processingDeadline)
      if candidates == nil { outcome = .deadlineExhausted }
      cachedCollapsedTabCandidates = candidates ?? []
      return candidates ?? []
    }

    // Acquisition serializes reported frames only; no coordinate space or fold decision is carried
    // down the walk (#2661). Its sole bounds are raw traversal depth (nil for a regular capture) and
    // the node cap; `SnapshotPresentation` folds and cuts the normalized array.
    var root = makeSnapshotNode(
      snapshot: context.rootSnapshot,
      evaluation: evaluateSnapshot(context.rootSnapshot),
      depth: 0,
      index: 0,
      parentIndex: nil
    )
    Self.publishLitPanelRoot(&root, surface: context.litPanelSurface)
    let rootChildren = try Self.litPanelRootChildren(context.rootSnapshot, surface: context.litPanelSurface)
    var nodes: [RawAXNode] = [root]
    if Self.canDescendAtRawDepth(0, hint: hint) {
      try appendCollapsedTabFallbackNodes(
        to: &nodes,
        containerSnapshot: context.rootSnapshot,
        resolveCandidates: collapsedTabCandidatesOnce,
        depth: 1,
        parentIndex: 0
      )
    }

    var regularTree = RegularSnapshotTree(policy: .platformDefault)
    var stack: [SnapshotTraversalEntry] = []
    if Self.canDescendAtRawDepth(0, hint: hint) {
      stack = rootChildren.map {
        SnapshotTraversalEntry(snapshot: $0, depth: 1, parentIndex: 0)
      }
    }

    while let entry = stack.popLast() {
      let snapshot = entry.snapshot
      let depth = entry.depth
      if let limit = hint.rawTraversalDepth, depth > limit { continue }

      let evaluation = evaluateSnapshot(snapshot)
      let node = makeSnapshotNode(
        snapshot: snapshot,
        evaluation: evaluation,
        depth: depth,
        index: nodes.count,
        parentIndex: entry.parentIndex
      )
      let included = regularTree.append(node, elementType: String(describing: snapshot.elementType), to: &nodes)
      let currentIndex = included ? node.index : entry.parentIndex
      for child in snapshot.children.reversed() {
        stack.append(
          SnapshotTraversalEntry(snapshot: child, depth: depth + 1, parentIndex: currentIndex)
        )
      }

      if !included { continue }
      if nodes.count > Self.regularSnapshotMaxNodes {
        throw regularSnapshotTooLargeFailure(nodeCount: nodes.count)
      }
      if Self.canDescendAtRawDepth(depth, hint: hint) {
        try appendCollapsedTabFallbackNodes(
          to: &nodes,
          containerSnapshot: snapshot,
          resolveCandidates: collapsedTabCandidatesOnce,
          depth: depth + 1,
          parentIndex: node.index
        )
      }
    }

    return (
      SnapshotAcquisition(
        hint: hint,
        nodes: nodes,
        truncated: outcome == .deadlineExhausted,
        effectiveDepth: nil,
        viewport: context.viewport
      ),
      outcome
    )
  }

  /// A lit-panel snapshot's root, raw or regular, is the booked box (ADR 0025).
  static func publishLitPanelRoot(_ root: inout RawAXNode, surface: LitPanelSurface?) {
    if let surface {
      root.rect = SnapshotRect(surface.geometry.windowOnScreen.rect)
    }
  }

  /// A lit-panel snapshot descends only into windows proven on the lit display; none refuses.
  static func litPanelRootChildren(
    _ root: XCUIElementSnapshot,
    surface: LitPanelSurface?
  ) throws -> [XCUIElementSnapshot] {
    guard let surface else { return root.children }
    let lit = windowsOnLitDisplay(root.children, litDisplayID: surface.displayID) { snapshotDisplayID($0) }
    if lit.isEmpty {
      throw RunnerAppScreenCaptureFailure.unresolvedScreen
    }
    return lit
  }

  /// A window that reports no display is dropped: it may be on the dark panel.
  static func windowsOnLitDisplay<Window>(
    _ windows: [Window],
    litDisplayID: UInt,
    displayID: (Window) -> UInt?
  ) -> [Window] {
    windows.filter { displayID($0) == litDisplayID }
  }

  /// The display a window snapshot reports, or nil when the runtime names none.
  static func snapshotDisplayID(_ snapshot: XCUIElementSnapshot) -> UInt? {
    var displayID: UInt?
    _ = RunnerObjCExceptionCatcher.catchException({
      displayID = ((snapshot as AnyObject).value(forKey: "displayID") as? NSNumber)?.uintValue
    })
    return displayID.flatMap { $0 == 0 ? nil : $0 }
  }

  // See `snapshotFast` above: the single production entry point, no unit-test overload.
  func snapshotRaw(target: SnapshotCaptureTarget, options: PresentationOptions) throws -> DataPayload {
    try snapshotAfterSystemAlertTier(
      plan: Self.rawDiagnosticPlan,
      terminal: .throwOnAXFailure,
      target: target,
      options: options
    )
  }

  private func snapshotAfterSystemAlertTier(
    plan: [SnapshotBackendKind],
    terminal: SnapshotCaptureTerminalPolicy,
    target: SnapshotCaptureTarget,
    options: PresentationOptions
  ) throws -> DataPayload {
    let deadline = Date().addingTimeInterval(Self.snapshotPlanBudget)
    if let blocking = boundedBlockingSystemAlertSnapshot(
      deadline: deadline,
      penaltyTarget: .prepared(bundleId: target.bundleId),
      options: options
    ) {
      if target.refusesSystemAlertSubstitution {
        throw SystemAlertSubstitutionRefused()
      }
      return blocking
    }
    return try runSnapshotCapturePlan(
      plan,
      target: target,
      options: options,
      terminal: terminal,
      deadline: deadline
    )
  }

  /// Runs the pre-plan SpringBoard system-modal probe as a bounded capture tier sharing the plan
  /// deadline, so a slow alert enumeration cannot bypass the snapshot timeout and stall (#1244).
  /// An abandoned probe penalizes the XCTest channel for `penaltyTarget`.
  func boundedBlockingSystemAlertSnapshot(
    deadline: Date,
    penaltyTarget: SnapshotProbePenaltyTarget,
    options: PresentationOptions
  ) -> DataPayload? {
    boundedBlockingSystemAlertSnapshotBody(
      deadline: deadline,
      penaltyTarget: penaltyTarget
    ) { probeDeadline in
      #if AGENT_DEVICE_RUNNER_UNIT_TESTS
      if let override = self.systemModalProbeOverrideForTesting {
        return override(probeDeadline)
      }
      #endif
      return try self.blockingSystemAlertSnapshot(options: options, deadline: probeDeadline)
    }
  }

  /// The real bounding/hook machinery used by `boundedBlockingSystemAlertSnapshot` above: the
  /// probe closure it's given always calls `self.blockingSystemAlertSnapshot` in production, and
  /// in unit-test builds may first consult `systemModalProbeOverrideForTesting`. Keeping this in
  /// one place means the main-thread dispatch and its penalty hook can never drift between what
  /// production runs and what the unit tests exercise.
  private func boundedBlockingSystemAlertSnapshotBody(
    deadline: Date,
    penaltyTarget: SnapshotProbePenaltyTarget,
    probe: @escaping @MainActor (Date) throws -> DataPayload?
  ) -> DataPayload? {
    #if os(macOS)
      return nil
    #else
    let slice = Self.systemModalProbeSlice(
      budget: systemModalProbeBudget,
      deadlineRemaining: deadline.timeIntervalSinceNow
    )
    guard slice > 0 else {
      NSLog("AGENT_DEVICE_RUNNER_SYSTEM_MODAL_PROBE_SKIPPED reason=budget_exhausted")
      return nil
    }
    let probeDeadline = Date().addingTimeInterval(slice)
    let startedAt = Date()
    let penaltyIdentity = SnapshotProbePenaltyIdentity(penaltyTarget)
    do {
      return try runMainThreadWork(
        "system_modal_probe",
        timeout: slice,
        timeoutError: {
          SnapshotCaptureFailure(
            code: Self.xCTestSnapshotTimeoutCode,
            message: "the system-modal probe exceeded its \(slice)s time slice",
            hint: "The capture plan recovers through non-XCTest snapshot tiers while the modal probe drains."
          )
        },
        onAbandoned: {
          self.penalizeSnapshotXCTestChannel(
            bundleId: penaltyIdentity.penalizedBundleId,
            reason: "system_modal_probe_timeout"
          )
        }
      ) {
        penaltyIdentity.captureFromMain(bundleId: self.mainOwned.bundleId)
        return try probe(probeDeadline)
      }
    } catch {
      NSLog(
        "AGENT_DEVICE_RUNNER_SYSTEM_MODAL_PROBE_ABORTED elapsedMs=%d error=%@",
        Int(Date().timeIntervalSince(startedAt) * 1000),
        String(describing: error)
      )
      return nil
    }
    #endif
  }

  /// The probe gets its own budget, clamped by whatever remains of the shared plan deadline, and
  /// 0 (skip entirely) once that deadline is already spent.
  static func systemModalProbeSlice(
    budget: TimeInterval,
    deadlineRemaining: TimeInterval
  ) -> TimeInterval {
    guard deadlineRemaining > 0 else { return 0 }
    return min(budget, deadlineRemaining)
  }

  func rawTreeSnapshotAcquisition(
    context: SnapshotTraversalContext,
    hint: CaptureHint
  ) throws -> SnapshotAcquisition {
    var nodes: [RawAXNode] = []

    func walk(
      _ snapshot: XCUIElementSnapshot,
      depth: Int,
      parentIndex: Int?,
      children: [XCUIElementSnapshot]? = nil
    ) throws {
      if let limit = hint.rawTraversalDepth, depth > limit { return }

      let evaluation = evaluateSnapshot(snapshot)
      if nodes.count >= Self.rawSnapshotMaxNodes {
        throw rawSnapshotTooLargeFailure(nodeCount: nodes.count + 1)
      }
      let currentIndex = nodes.count
      nodes.append(
        makeSnapshotNode(
          snapshot: snapshot,
          evaluation: evaluation,
          depth: depth,
          index: currentIndex,
          parentIndex: parentIndex
        )
      )

      for child in children ?? snapshot.children {
        try walk(
          child,
          depth: depth + 1,
          parentIndex: currentIndex
        )
      }
    }

    try walk(
      context.rootSnapshot,
      depth: 0,
      parentIndex: nil,
      children: try Self.litPanelRootChildren(context.rootSnapshot, surface: context.litPanelSurface)
    )
    if !nodes.isEmpty {
      Self.publishLitPanelRoot(&nodes[0], surface: context.litPanelSurface)
    }
    return SnapshotAcquisition(
      hint: hint,
      nodes: nodes,
      truncated: false,
      effectiveDepth: nil,
      viewport: context.viewport
    )
  }

  @MainActor
  func querySweepSnapshotAcquisition(
    app: XCUIApplication,
    hint: CaptureHint,
    sliceDeadline deadline: Date
  ) throws -> (acquisition: SnapshotAcquisition, outcome: SnapshotTierOutcome) {
    var nodes: [RawAXNode] = [
      interactiveRootNode(rect: .zero)
    ]
    if hint.rawTraversalDepth == 0 || hint.regularPresentedDepth == 0 {
      return (
        SnapshotAcquisition(
          hint: hint,
          nodes: nodes,
          truncated: false,
          effectiveDepth: nil,
          viewport: .missing(reason: .notProvided)
        ),
        .completed
      )
    }

    let viewport = try safeSnapshotViewport(app: app, readingOrientation: false)
    var seen = Set<String>()
    var candidates: [RawAXNode] = []
    let flatElements = flatInteractiveElements(app: app, deadline: deadline)
    var outcome = flatElements.outcome
    for element in flatElements.elements {
      if !Self.xctestQueryCanStart(deadline: deadline, now: Date()) {
        NSLog("AGENT_DEVICE_RUNNER_SNAPSHOT_FLAT_FALLBACK_DEADLINE")
        outcome = .deadlineExhausted
        break
      }
      guard let node = flatSnapshotNode(element: element, index: 0, parentIndex: 0) else {
        continue
      }
      let key = "\(node.type)-\(node.label ?? "")-\(node.identifier ?? "")-\(node.value ?? "")-\(node.rect.x)-\(node.rect.y)-\(node.rect.width)-\(node.rect.height)"
      if seen.contains(key) { continue }
      seen.insert(key)
      candidates.append(node)
    }
    candidates.sort { left, right in
      if left.rect.y != right.rect.y {
        return left.rect.y < right.rect.y
      }
      if left.rect.x != right.rect.x {
        return left.rect.x < right.rect.x
      }
      return left.type < right.type
    }

    // The synthetic root doubles as the daemon's viewport (find.ts prefers on-screen matches
    // inside nodes[0].rect): use the real screen viewport when the capture resolved one, so
    // off-screen candidates can never inflate the root and masquerade as on-screen.
    let rootRect = viewport.rect ?? interactiveRootFrame(for: candidates)
    nodes[0] = interactiveRootNode(rect: rootRect)
    for candidate in candidates {
      nodes.append(
        candidate.reindexed(index: nodes.count, depth: 1, parentIndex: 0)
      )
    }
    return (
      SnapshotAcquisition(
        hint: hint,
        nodes: nodes,
        truncated: outcome == .deadlineExhausted,
        effectiveDepth: nil,
        viewport: viewport
      ),
      outcome
    )
  }

  func snapshotAccessibilityUnavailable(failure: SnapshotCaptureFailure) -> DataPayload {
    NSLog("AGENT_DEVICE_RUNNER_SNAPSHOT_AX_UNAVAILABLE=%@", failure.message)
    applyMainOwnedSnapshotState("ax_unavailable_invalidation") {
      self.mainOwned.accessibilityHealth = .unavailable
      self.invalidateCachedTarget(reason: Self.axSnapshotUnavailableReason)
    }
    // This is a planned terminal result, so it carries the structured verdict like every other
    // planned snapshot — downstream sparse handling keys off the verdict, not node shapes.
    return sparseTruncatedSnapshotPayload(
      message: recoveredSnapshotMessage(failure),
      snapshotQuality: SnapshotQuality(
        state: .sparse,
        backend: SnapshotBackendKind.recursiveTree.rawValue,
        reason: failure.message,
        reasonCode: "ax-rejected",
        effectiveDepth: nil,
        collapsedLeafIndexes: nil,
        customActions: nil
      ),
      runnerFatal: true,
      runnerFatalReason: Self.axSnapshotUnavailableReason
    )
  }

  func recoveredSnapshotMessage(_ failure: SnapshotCaptureFailure) -> String {
    return "\(failure.message) Hint: \(failure.hint)"
  }

  func rawSnapshotTooLargeFailure(nodeCount: Int) -> SnapshotCaptureFailure {
    SnapshotCaptureFailure(
      code: Self.rawSnapshotTooLargeCode,
      message: "iOS raw snapshot exceeded \(Self.rawSnapshotMaxNodes) nodes while walking node \(nodeCount).",
      hint: Self.rawSnapshotTooLargeHint
    )
  }

  private func regularSnapshotTooLargeFailure(nodeCount: Int) -> SnapshotCaptureFailure {
    SnapshotCaptureFailure(
      code: Self.regularSnapshotTooLargeCode,
      message: "iOS snapshot exceeded \(Self.regularSnapshotMaxNodes) nodes while walking node \(nodeCount).",
      hint: Self.regularSnapshotTooLargeHint
    )
  }

  func sparseTruncatedSnapshotPayload(
    message: String? = nil,
    snapshotQuality: SnapshotQuality? = nil,
    runnerFatal: Bool? = nil,
    runnerFatalReason: String? = nil
  ) -> DataPayload {
    return DataPayload(
      message: message,
      nodes: [SnapshotPresentation.singleElementRead(interactiveRootNode(rect: .zero))],
      truncated: true,
      snapshotQuality: snapshotQuality,
      runnerFatal: runnerFatal,
      runnerFatalReason: runnerFatalReason
    )
  }
}
