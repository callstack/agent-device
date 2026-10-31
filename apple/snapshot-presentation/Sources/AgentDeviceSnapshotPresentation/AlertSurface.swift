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
