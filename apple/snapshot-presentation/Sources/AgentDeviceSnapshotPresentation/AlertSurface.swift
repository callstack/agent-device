import CoreGraphics
import Foundation

/// One node of an accessibility tree as the alert rules read it. `type` is the XCUIElement type
/// name ("Window", "Alert", "Other", ...), so a recorded tree and a live snapshot read the same.
public struct AlertSurfaceNode: Equatable {
  public let type: String
  public let identifier: String
  public let label: String
  public let frame: CGRect
  public let children: [AlertSurfaceNode]

  public init(type: String, identifier: String, label: String, frame: CGRect, children: [AlertSurfaceNode]) {
    self.type = type
    self.identifier = identifier
    self.label = label
    self.frame = frame
    self.children = children
  }
}

/// Which kind of surface an `alert` command answers.
public enum AlertSurfaceSource: String, CaseIterable, Codable {
  case blockingSystemModal
  case appAlert
  case safariDialog
  case dismissPopup
}

/// A dialog-like container none of the alert rules answers, reported so an `alert` command that
/// found no alert can name what is on screen instead of leaving "alert not found" unexplained.
public struct AlertSurfaceNearMiss: Equatable {
  public let type: String
  public let identifier: String
  /// The container's own label, or the first text it shows when it has none.
  public let label: String
  /// Labels of the container's actionable descendants, in document order.
  public let buttons: [String]

  public init(type: String, identifier: String, label: String, buttons: [String]) {
    self.type = type
    self.identifier = identifier
    self.label = label
    self.buttons = buttons
  }
}

public struct AlertSurfacePresentation: Equatable {
  public let title: String
  public let content: [String]
  public let buttons: [String]

  public init(title: String, content: [String], buttons: [String]) {
    self.title = title
    self.content = content
    self.buttons = buttons
  }
}

/// The rules that decide which node of a tree is an alert surface. The runner observes alerts
/// through these rules, and recorded trees in the test corpus replay them on the host.
public enum AlertSurface {
  /// Safari draws its page prompts, such as "Open this page in …?" and JavaScript dialogs, as a
  /// view rather than an alert, so they are found by the view's identifier.
  public static let safariDialogIdentifier = "SFDialogView"

  /// A popover's dismiss region: a label or identifier that reads "dismiss popup", in any case,
  /// with any surrounding whitespace. XCTest queries take it as a `MATCHES[c]` pattern.
  public static let dismissPopupMarkerPattern = #"\s*dismiss popup\s*"#

  /// Element types an alert action can be. Kept narrow to avoid generic hittable containers.
  public static let actionableTypes: Set<String> = ["Button", "Cell", "Link", "MenuItem", "CheckBox", "Switch"]

  /// Element types that are the app's chrome rather than content, so never a near miss.
  static let chromeTypes: Set<String> = [
    "Application", "Window", "Keyboard", "NavigationBar", "TabBar", "Toolbar", "Alert", "Sheet",
  ]

  /// Element types that name their own node when it has no label of its own.
  static let textTypes: Set<String> = ["StaticText", "TextView", "Text"]

  /// Part of the label XCTest gives a scroll indicator, "Vertical scroll bar, 8 pages", in every
  /// recorded tree. It names no question, so it never becomes a container's prompt copy.
  static let scrollBarNoise = "scroll bar"

  /// A container larger than this share of the box hosting it is the screen's own content, not a dialog.
  static let nearMissMaxAreaRatio: CGFloat = 0.6

  /// Types that make a container part of the screen's furniture when they appear anywhere below it.
  /// Chrome a prompt legitimately sits in does not count.
  static let nearMissExcludedSubtreeTypes: Set<String> = chromeTypes.subtracting([
    "Application", "Window", "Alert", "Sheet",
  ])

  static let nearMissMinButtons = 2

  static let nearMissMaxButtons = 4

  /// How many near misses one refusal names. A screen that looks like this many prompts is a
  /// reading the rules cannot settle, and a long list is a payload nobody acts on.
  static let nearMissMaxReports = 4

  public static func isDismissPopupMarker(_ text: String) -> Bool {
    text.range(of: "^\(dismissPopupMarkerPattern)$", options: [.regularExpression, .caseInsensitive]) != nil
  }

  /// Whether a node is on screen in the window that hosts it. A foldable's SpringBoard has a
  /// window on each panel, and the application frame names only one of them.
  public static func isPlaced(_ frame: CGRect, in hostWindow: CGRect) -> Bool {
    SnapshotGeometry.isPositiveFinite(frame) && SnapshotGeometry.isPositiveFinite(hostWindow)
      && hostWindow.contains(CGPoint(x: frame.midX, y: frame.midY))
  }

  /// The surfaces of `source` in `root`, each placed in the box it sits in. A window is placed in
  /// its parent's box and is itself the box of what it hosts.
  public static func candidates(in root: AlertSurfaceNode, source: AlertSurfaceSource, viewport: CGRect) -> [AlertSurfaceNode] {
    if matches(root, source: source) && isPlaced(root.frame, in: viewport) { return [root] }
    let childViewport = root.type == "Window" && SnapshotGeometry.isPositiveFinite(root.frame) ? root.frame : viewport
    return root.children.flatMap { candidates(in: $0, source: source, viewport: childViewport) }
  }

  /// The dialog-like containers in `root` that no source answers: a compact placed container that
  /// holds a few actionable descendants and text of its own, such as Safari's page prompt would be
  /// before the `safariDialog` rule existed. An `alert` command reports these when it finds no
  /// alert, so the caller can tell "no prompt" from "a prompt this release does not recognise".
  ///
  /// Conservative by design: a wrong near miss sends an agent to press the wrong control, so a
  /// container is reported only when every check holds, and the search stops at a reported one.
  /// At most `nearMissMaxReports` come back, in document order.
  public static func nearMisses(
    in root: AlertSurfaceNode,
    viewport: CGRect,
    sources: [AlertSurfaceSource] = Array(AlertSurfaceSource.allCases)
  ) -> [AlertSurfaceNearMiss] {
    var found: [AlertSurfaceNearMiss] = []
    collectNearMisses(in: root, hostWindow: viewport, sources: sources, into: &found)
    return found
  }

  public static func presentation(of surface: AlertSurfaceNode) -> AlertSurfacePresentation {
    var content: [String] = []
    var buttons: [String] = []
    func collect(_ node: AlertSurfaceNode) {
      let label = node.label.trimmingCharacters(in: .whitespacesAndNewlines)
      if actionableTypes.contains(node.type) {
        buttons.append(label)
      } else if !label.isEmpty {
        content.append(label)
      }
      node.children.forEach(collect)
    }
    surface.children.forEach(collect)
    return AlertSurfacePresentation(
      title: surface.label.trimmingCharacters(in: .whitespacesAndNewlines),
      content: content,
      buttons: buttons
    )
  }

  private static func collectNearMisses(
    in node: AlertSurfaceNode,
    hostWindow: CGRect,
    sources: [AlertSurfaceSource],
    into found: inout [AlertSurfaceNearMiss]
  ) {
    if found.count >= nearMissMaxReports { return }
    let childWindow = node.type == "Window" && SnapshotGeometry.isPositiveFinite(node.frame) ? node.frame : hostWindow
    // A container a source already answers, and everything inside it, belongs to a recognised
    // prompt; reporting its parts would blame a rule that works.
    if sources.contains(where: { matches(node, source: $0) }) { return }
    if let nearMiss = nearMiss(in: node, hostWindow: hostWindow) {
      found.append(nearMiss)
      return
    }
    node.children.forEach { collectNearMisses(in: $0, hostWindow: childWindow, sources: sources, into: &found) }
  }

  /// The near miss a container is, or nil when it fails a check. A container is a near miss when it
  /// is placed in the box hosting it, is not chrome, is not almost as large as its host, is not
  /// itself actionable, covers no keyboard or system bar in its subtree, holds two to four
  /// actionable descendants that each name themselves, and shows copy of its own that no button of
  /// its already says. The copy check is what keeps toolbars and tab bars out: their buttons carry
  /// labels, the cluster shows no copy. The label check keeps out a suggestion list, whose rows act
  /// through an unnamed container. Reading only copy the buttons do not say, and none of it inside
  /// an action, keeps out a web page's navigation cell, whose words are the link it wraps. The
  /// caller has already refused the container to any source, so this checks the rest.
  private static func nearMiss(in node: AlertSurfaceNode, hostWindow: CGRect) -> AlertSurfaceNearMiss? {
    if chromeTypes.contains(node.type) || actionableTypes.contains(node.type) { return nil }
    guard isPlaced(node.frame, in: hostWindow) else { return nil }
    if hostWindow.width * hostWindow.height > 0,
       node.frame.width * node.frame.height / (hostWindow.width * hostWindow.height) > nearMissMaxAreaRatio {
      return nil
    }
    if subtreeTypes(of: node).contains(where: { nearMissExcludedSubtreeTypes.contains($0) }) { return nil }
    let buttons = actionableDescendants(of: node)
    guard buttons.count >= nearMissMinButtons, buttons.count <= nearMissMaxButtons else { return nil }
    let buttonLabels = Set(buttons.map { $0.label.trimmingCharacters(in: .whitespacesAndNewlines) })
    guard buttonLabels.allSatisfy({ !$0.isEmpty }) else { return nil }
    guard let copy = promptCopy(of: node, besides: buttonLabels) else { return nil }
    return AlertSurfaceNearMiss(
      type: node.type,
      identifier: node.identifier,
      label: copy,
      buttons: buttons.map { $0.label.trimmingCharacters(in: .whitespacesAndNewlines) }
    )
  }

  /// The copy that names what a container asks, or nil when it shows none. The container's own
  /// label comes first, then the first text below it. Words an action of the container already
  /// carries, and XCTest's scroll-indicator label, are not copy the container asks: a navigation
  /// cell's text is the link it wraps, a scroll bar names its own axis, while a prompt's question is
  /// not one of its button labels. Action subtrees are not read, so a button's own words never
  /// become the container's.
  private static func promptCopy(of node: AlertSurfaceNode, besides buttonLabels: Set<String>) -> String? {
    let label = node.label.trimmingCharacters(in: .whitespacesAndNewlines)
    if isPromptCopy(label, besides: buttonLabels) { return label }
    return textCopy(in: node, besides: buttonLabels)
  }

  private static func actionableDescendants(of node: AlertSurfaceNode) -> [AlertSurfaceNode] {
    var found: [AlertSurfaceNode] = actionableTypes.contains(node.type) ? [node] : []
    node.children.forEach { found.append(contentsOf: actionableDescendants(of: $0)) }
    return found
  }

  /// A container's prompt copy is the text it shows outside every actionable subtree. A cell's or a
  /// link's text is that row's own words, so a list of labelled rows has no copy of its own, and
  /// only the container's own label or text beside it can ask something.
  private static func textCopy(in node: AlertSurfaceNode, besides buttonLabels: Set<String>) -> String? {
    if actionableTypes.contains(node.type) { return nil }
    let label = node.label.trimmingCharacters(in: .whitespacesAndNewlines)
    if textTypes.contains(node.type), isPromptCopy(label, besides: buttonLabels) {
      return label
    }
    for child in node.children {
      if let copy = textCopy(in: child, besides: buttonLabels) { return copy }
    }
    return nil
  }

  /// Whether a label is copy a container asks. It must say something, and no action of the
  /// container may already say it.
  private static func isPromptCopy(_ label: String, besides buttonLabels: Set<String>) -> Bool {
    guard !label.isEmpty, !buttonLabels.contains(label) else { return false }
    return label.range(of: scrollBarNoise, options: .caseInsensitive) == nil
  }

  private static func subtreeTypes(of node: AlertSurfaceNode) -> Set<String> {
    var types: Set<String> = [node.type]
    node.children.forEach { types.formUnion(subtreeTypes(of: $0)) }
    return types
  }

  private static func matches(_ node: AlertSurfaceNode, source: AlertSurfaceSource) -> Bool {
    switch source {
    case .blockingSystemModal:
      return node.type == "Alert" || node.type == "Sheet"
    case .appAlert:
      return node.type == "Alert"
    case .safariDialog:
      return node.identifier == safariDialogIdentifier
    case .dismissPopup:
      return node.type == "Window" && containsDismissPopupMarker(node)
    }
  }

  private static func containsDismissPopupMarker(_ node: AlertSurfaceNode) -> Bool {
    isDismissPopupMarker(node.label) || isDismissPopupMarker(node.identifier)
      || node.children.contains { containsDismissPopupMarker($0) }
  }
}
