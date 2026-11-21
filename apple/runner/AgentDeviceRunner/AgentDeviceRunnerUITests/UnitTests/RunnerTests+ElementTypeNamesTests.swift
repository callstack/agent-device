import XCTest

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
/// Runner-side tie for the golden table `contracts/fixtures/ios-element-type-names.json` — the one
/// list of element-type names both iOS producers read (#4657). The Simulator AX bridge is tied to the
/// same table by `tree.test.ts`; the two ties together are what makes one node carry one `type`
/// whichever producer served it.
///
/// Each row is read back through the production `elementTypeName`, so the table cannot name a type
/// this producer publishes differently. A row that names an SDK case is also compared with that
/// case's own raw value, so an SDK that renumbers a case fails here against the SDK rather than
/// against a second handwritten list, the way `RunnerTests+ApplicationStateRawValueTests` does for
/// application states.
private struct ElementTypeNamesTable: Decodable {
  let unnamedTypeSpelling: String
  let types: [Row]

  struct Row: Equatable {
    let rawValue: Int
    let sdkCase: String?
    let name: String
  }
}

private func loadElementTypeNamesTable() throws -> ElementTypeNamesTable {
  let fixtureURL = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent() // UnitTests
    .deletingLastPathComponent() // AgentDeviceRunnerUITests
    .deletingLastPathComponent() // AgentDeviceRunner
    .deletingLastPathComponent() // runner
    .deletingLastPathComponent() // apple
    .deletingLastPathComponent() // repo root
    .appendingPathComponent("contracts/fixtures/ios-element-type-names.json")
  return try JSONDecoder().decode(
    ElementTypeNamesTable.self,
    from: Data(contentsOf: fixtureURL)
  )
}

extension RunnerTests {
  /// Every row of the shared table publishes its name through this producer's own lookup, and every
  /// row this producer pins is in the table. Fails at the base table, which named 32 rows: a row it
  /// lacked reaches a snapshot as `Element(<rawValue>)` where the bridge reports the name (#4657).
  func testElementTypeNamesTablePublishesEveryRowThroughTheRunnerLookup() throws {
    let table = try loadElementTypeNamesTable()
    var pinned = Set<String>()
    assertNamedRow(table, "any", .any, &pinned)
    assertNamedRow(table, "other", .other, &pinned)
    assertNamedRow(table, "application", .application, &pinned)
    assertNamedRow(table, "group", .group, &pinned)
    assertNamedRow(table, "window", .window, &pinned)
    assertNamedRow(table, "sheet", .sheet, &pinned)
    assertNamedRow(table, "drawer", .drawer, &pinned)
    assertNamedRow(table, "alert", .alert, &pinned)
    assertNamedRow(table, "dialog", .dialog, &pinned)
    assertNamedRow(table, "button", .button, &pinned)
    assertNamedRow(table, "radioButton", .radioButton, &pinned)
    assertNamedRow(table, "radioGroup", .radioGroup, &pinned)
    assertNamedRow(table, "checkBox", .checkBox, &pinned)
    assertNamedRow(table, "disclosureTriangle", .disclosureTriangle, &pinned)
    assertNamedRow(table, "popUpButton", .popUpButton, &pinned)
    assertNamedRow(table, "comboBox", .comboBox, &pinned)
    assertNamedRow(table, "menuButton", .menuButton, &pinned)
    assertNamedRow(table, "toolbarButton", .toolbarButton, &pinned)
    assertNamedRow(table, "popover", .popover, &pinned)
    assertNamedRow(table, "navigationBar", .navigationBar, &pinned)
    assertNamedRow(table, "tabBar", .tabBar, &pinned)
    assertNamedRow(table, "tabGroup", .tabGroup, &pinned)
    assertNamedRow(table, "toolbar", .toolbar, &pinned)
    assertNamedRow(table, "statusBar", .statusBar, &pinned)
    assertNamedRow(table, "table", .table, &pinned)
    assertNamedRow(table, "tableRow", .tableRow, &pinned)
    assertNamedRow(table, "tableColumn", .tableColumn, &pinned)
    assertNamedRow(table, "outline", .outline, &pinned)
    assertNamedRow(table, "outlineRow", .outlineRow, &pinned)
    assertNamedRow(table, "browser", .browser, &pinned)
    assertNamedRow(table, "collectionView", .collectionView, &pinned)
    assertNamedRow(table, "slider", .slider, &pinned)
    assertNamedRow(table, "pageIndicator", .pageIndicator, &pinned)
    assertNamedRow(table, "progressIndicator", .progressIndicator, &pinned)
    assertNamedRow(table, "activityIndicator", .activityIndicator, &pinned)
    assertNamedRow(table, "segmentedControl", .segmentedControl, &pinned)
    assertNamedRow(table, "picker", .picker, &pinned)
    assertNamedRow(table, "pickerWheel", .pickerWheel, &pinned)
    assertNamedRow(table, "switch", .switch, &pinned)
    assertNamedRow(table, "toggle", .toggle, &pinned)
    assertNamedRow(table, "link", .link, &pinned)
    assertNamedRow(table, "image", .image, &pinned)
    assertNamedRow(table, "icon", .icon, &pinned)
    assertNamedRow(table, "searchField", .searchField, &pinned)
    assertNamedRow(table, "scrollView", .scrollView, &pinned)
    assertNamedRow(table, "scrollBar", .scrollBar, &pinned)
    assertNamedRow(table, "staticText", .staticText, &pinned)
    assertNamedRow(table, "textField", .textField, &pinned)
    assertNamedRow(table, "secureTextField", .secureTextField, &pinned)
    assertNamedRow(table, "datePicker", .datePicker, &pinned)
    assertNamedRow(table, "textView", .textView, &pinned)
    assertNamedRow(table, "menu", .menu, &pinned)
    assertNamedRow(table, "menuItem", .menuItem, &pinned)
    assertNamedRow(table, "menuBar", .menuBar, &pinned)
    assertNamedRow(table, "menuBarItem", .menuBarItem, &pinned)
    assertNamedRow(table, "map", .map, &pinned)
    assertNamedRow(table, "webView", .webView, &pinned)
    assertNamedRow(table, "incrementArrow", .incrementArrow, &pinned)
    assertNamedRow(table, "decrementArrow", .decrementArrow, &pinned)
    assertNamedRow(table, "timeline", .timeline, &pinned)
    assertNamedRow(table, "ratingIndicator", .ratingIndicator, &pinned)
    assertNamedRow(table, "valueIndicator", .valueIndicator, &pinned)
    assertNamedRow(table, "splitGroup", .splitGroup, &pinned)
    assertNamedRow(table, "splitter", .splitter, &pinned)
    assertNamedRow(table, "relevanceIndicator", .relevanceIndicator, &pinned)
    assertNamedRow(table, "colorWell", .colorWell, &pinned)
    assertNamedRow(table, "helpTag", .helpTag, &pinned)
    assertNamedRow(table, "matte", .matte, &pinned)
    assertNamedRow(table, "dockItem", .dockItem, &pinned)
    assertNamedRow(table, "ruler", .ruler, &pinned)
    assertNamedRow(table, "rulerMarker", .rulerMarker, &pinned)
    assertNamedRow(table, "grid", .grid, &pinned)
    assertNamedRow(table, "levelIndicator", .levelIndicator, &pinned)
    assertNamedRow(table, "cell", .cell, &pinned)
    assertNamedRow(table, "layoutArea", .layoutArea, &pinned)
    assertNamedRow(table, "layoutItem", .layoutItem, &pinned)
    assertNamedRow(table, "handle", .handle, &pinned)
    assertNamedRow(table, "stepper", .stepper, &pinned)
    assertNamedRow(table, "tab", .tab, &pinned)
    assertNamedRow(table, "touchBar", .touchBar, &pinned)
    assertNamedRow(table, "statusItem", .statusItem, &pinned)
    // Two names the table keys by number alone: the SDK hides these cases from Swift on some
    // platforms, which is why this producer's table spells their raw values.
    assertNumberedRow(table, 19, &pinned)
    assertNumberedRow(table, 20, &pinned)

    XCTAssertEqual(
      pinned,
      Set(table.types.compactMap { $0.sdkCase ?? "raw:\($0.rawValue)" }),
      "the runner's pinned rows and the shared table's rows differ"
    )
    XCTAssertEqual(
      Self.elementTypeNamesByRawValue.count,
      table.types.count,
      "the runner names an element type the shared table does not carry"
    )
  }

  /// Every raw value the shared table leaves unnamed still reaches a snapshot as the raw-value
  /// spelling, which is what the presented-surface rule reads for a producer that names nothing
  /// (#3565).
  func testElementTypeNamesFallBackToTheRawValueSpellingTheTableDeclares() throws {
    let table = try loadElementTypeNamesTable()
    XCTAssertEqual(
      table.unnamedTypeSpelling,
      "Element(<rawValue>)",
      "the shared table declares the fallback spelling both producers must keep"
    )
    let unnamed = try XCTUnwrap(table.types.map(\.rawValue).max()) + 1
    XCTAssertEqual(
      elementTypeName(XCUIElement.ElementType(rawValue: UInt(unnamed))),
      "Element(\(unnamed))",
      "the runner must spell an unnamed raw value the way the shared table declares"
    )
  }

  /// Pins one table row: the SDK case still carries the raw value the table maps its name to, and
  /// this producer publishes that name for the case.
  private func assertNamedRow(
    _ table: ElementTypeNamesTable,
    _ sdkCase: String,
    _ type: XCUIElement.ElementType,
    _ pinned: inout Set<String>,
    file: StaticString = #filePath,
    line: UInt = #line
  ) {
    guard let row = table.types.first(where: { $0.sdkCase == sdkCase }) else {
      XCTFail("the shared table carries no row for SDK case \(sdkCase)", file: file, line: line)
      return
    }
    XCTAssertEqual(
      row.rawValue,
      Int(type.rawValue),
      "XCUIElement.ElementType.\(sdkCase) no longer carries the raw value the shared table maps to \"\(row.name)\"",
      file: file,
      line: line
    )
    XCTAssertEqual(
      elementTypeName(type),
      row.name,
      "raw value \(row.rawValue) (\(row.name)) is named differently by the runner and by the shared table",
      file: file,
      line: line
    )
    pinned.insert(sdkCase)
  }

  /// Pins one table row the SDK gives no Swift case for: the number alone decides the name, on both
  /// producers.
  private func assertNumberedRow(
    _ table: ElementTypeNamesTable,
    _ rawValue: Int,
    _ pinned: inout Set<String>,
    file: StaticString = #filePath,
    line: UInt = #line
  ) {
    guard let row = table.types.first(where: { $0.rawValue == rawValue }) else {
      XCTFail("the shared table carries no row for raw value \(rawValue)", file: file, line: line)
      return
    }
    XCTAssertNil(
      row.sdkCase,
      "raw value \(rawValue) is named \"\(row.name)\" with no SDK case; this producer keys it by number",
      file: file,
      line: line
    )
    XCTAssertEqual(
      elementTypeName(XCUIElement.ElementType(rawValue: UInt(rawValue))),
      row.name,
      "raw value \(rawValue) is named differently by the runner and by the shared table",
      file: file,
      line: line
    )
    pinned.insert("raw:\(rawValue)")
  }
}
#endif
