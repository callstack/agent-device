import Foundation

/// What a capture's producer claims about its own completeness (#3565), stated by the caller rather
/// than inferred from the tree: `complete` when the producer reports the capture is not capped, `capped`
/// when it reports a cap, `unstated` when the producer observes nothing either way. A presented-surface
/// classification may not read a silent field as "complete".
public enum PresentedSurfaceCompleteness: Equatable {
  case complete
  case capped
  case unstated
}

/// One node as the presented-surface rule reads it: the element type every iOS producer publishes, and
/// the UIKit class name only some of them report. A `nil` `className` states a fact about the capture —
/// its producer reports no class names at all, which is true of every XCTest runner tier — so the rule
/// knows not to read window structure it was never given.
public struct PresentedSurfaceNode {
  public let index: Int
  public let parentIndex: Int?
  public let elementType: String
  public let className: String?

  public init(index: Int, parentIndex: Int?, elementType: String, className: String?) {
    self.index = index
    self.parentIndex = parentIndex
    self.elementType = elementType
    self.className = className
  }
}

extension PresentedSurfaceNode {
  /// One acquired node. An accessibility-tree node carries no UIKit class name, which is what makes a
  /// runner capture unable to earn `absent` rather than merely undecided.
  public init(_ node: RawAXNode) {
    self.init(
      index: node.index,
      parentIndex: node.parentIndex,
      elementType: node.type,
      className: nil
    )
  }
}

/// Reads a modal presentation out of a captured tree (#3565), before interactive filtering, compaction,
/// depth, or scope, so every view of one screen answers one value.
///
/// This is the Swift half of a rule the TypeScript engine also runs (`collectPresentedSurface` in
/// `packages/capture-kit/src/ios-snapshot-engine/engine.ts`). The golden table
/// `contracts/fixtures/ios-presented-surface.json` pins the two against each other over the same tree
/// shapes, and each side mirrors the vocabulary below by hand the way the system-surface host registry
/// mirrors its own fixture.
///
/// UIKit appends each modal presentation as a later sibling of the container it presents over, directly
/// under the window, and dims what is behind it with a dimming view that is a direct child of that
/// container — the same shape the occlusion cut rests on. Because this rule decides only whether
/// something is presented and not what the user can still reach, it deliberately does NOT read a
/// dimming view's enablement: a sheet resting at an undimmed detent keeps a dimming view that takes no
/// touches and is still presented.
///
/// `absent` is earned and never defaulted, because a consumer arms a dismissal confirmation on it and a
/// wrong `absent` disarms that confirmation: the producer has to have stated the capture is complete,
/// every node has to carry the class name this rule reads, each node has to be numbered once so the
/// parent links this walk follows name the node they mean, and the one content window under the app root
/// has to hold exactly one presentation container.
public enum SnapshotPresentedSurface {
  /// The container UIKit appends per presentation, and the one it presents app content inside.
  public static let presentationContainerClass = "UITransitionView"

  /// The dimming view a presentation dims the content behind it with. Only a presentation installs one,
  /// so one anywhere inside the app's own windows answers presented. Its position is not a fact this rule
  /// may lean on: a live capture of a sheet holds one as a direct child of the presenting container AND
  /// one two levels deep under the app's own container's drop shadow, so the rule never asks which
  /// container a dimming view sits in.
  public static let dimmingViewClass = "UIDimmingView"

  /// The private root classes of a UIAlertController. An iPhone alert arrives in its own window with no
  /// dimming view anywhere in the capture, so these classes are the only evidence it holds.
  public static let alertRootClassPrefix = "_UIAlertController"

  /// Windows UIKit hosts outside the app's own scene. They can carry none of the app's presentations, so
  /// neither the window nor anything under its subtree counts as evidence in either direction. This is a
  /// denylist of the hosts iOS is known to name: a window class it does not name is read as app content,
  /// which is what keeps an app hosting its scene window in a subclass readable at all. The cost is that
  /// an unnamed host carrying a dimming view of its own would read as presented; no such host has been
  /// observed, while custom scene window classes are routine.
  public static let systemWindowClasses: Set<String> = [
    "UITextEffectsWindow",
    "UIRemoteKeyboardWindow",
  ]

  /// Element types that name a presentation wherever they appear, keyed by the shared element-type
  /// numbering every iOS producer reads. A producer whose own name table stops short of the name
  /// publishes `Element(<number>)` for the same node, so both spellings count and the raw-value spelling
  /// is derived from these numbers rather than listed beside them.
  public static let presentingElementTypes: [String: Int] = [
    "Sheet": 5,
    "Drawer": 6,
    "Alert": 7,
    "Dialog": 8,
  ]

  /// The fact for one captured tree, where `completeness` is the producer's own claim and never a
  /// reading of the tree.
  public static func classify(
    nodes: [PresentedSurfaceNode],
    completeness: PresentedSurfaceCompleteness
  ) -> PresentedSurface {
    let windowPositions = appWindowPositions(nodes)
    let examinable = positionsOutsideSystemWindows(nodes, windowPositions)
    // Positive evidence is evidence of what the producer did read, so a cap does not defeat it; absence
    // is what a cap defeats, along with any capture that cannot state its own window structure.
    if nodes.enumerated().contains(where: { examinable.contains($0.offset) && isPresentingEvidence($0.element) }) {
      return .presented
    }
    guard completeness == .complete else { return .unknown }
    guard !windowPositions.isEmpty, nodes.allSatisfy({ $0.className != nil }) else { return .unknown }
    // `absent` is a claim about every window the producer read, and window structure is read through
    // parent links, which cannot tell two nodes sharing a number apart. Positive evidence is already
    // reported above, keyed on the node it was read off rather than on its number, so the most a
    // collision can cost this rule is the answer it declines to make — never a false `absent`.
    guard Set(nodes.map(\.index)).count == nodes.count else { return .unknown }

    let contentWindows = windowPositions.filter { !isSystemWindow(nodes[$0]) }
    guard contentWindows.count == 1 else { return .unknown }
    return presentationContainers(of: nodes[contentWindows[0]], in: nodes).count == 1 ? .absent : .unknown
  }

  /// The fact for one acquisition as its producer holds it.
  public static func classify(_ acquisition: SnapshotAcquisition) -> PresentedSurface {
    classify(
      nodes: acquisition.nodes.map(PresentedSurfaceNode.init),
      completeness: acquisition.truncated ? .capped : .complete
    )
  }

  private static func isPresentingEvidence(_ node: PresentedSurfaceNode) -> Bool {
    guard let className = node.className.map(normalizeClassName) else {
      return isPresentingElementType(node.elementType)
    }
    if className == normalizeClassName(dimmingViewClass) { return true }
    if className.hasPrefix(normalizeClassName(alertRootClassPrefix)) { return true }
    return isPresentingElementType(node.elementType)
  }

  /// Class names are read the way the TypeScript rule reads them: `normalizeType` in
  /// `packages/contracts/src/snapshot-text.ts`, which the occlusion cut already matches UIKit classes
  /// through. A producer that spells a class with a module prefix or in another case has to reach the
  /// same answer in both languages, or the two readers disagree about the same capture, which is the
  /// drift the shared golden table exists to catch.
  private static func normalizeClassName(_ className: String) -> String {
    var normalized = className.trimmingCharacters(in: .whitespacesAndNewlines)
    normalized = normalized.replacingOccurrences(of: "XCUIElementType", with: "", options: .caseInsensitive)
    if normalized.hasPrefix("AX") {
      normalized = String(normalized.dropFirst(2))
    }
    normalized = normalized.lowercased()
    guard let separator = [".", "/"].compactMap({ normalized.lastIndex(of: $0) }).max() else {
      return normalized
    }
    return String(normalized[separator...].dropFirst())
  }

  private static func isPresentingElementType(_ elementType: String) -> Bool {
    if presentingElementTypes[elementType] != nil { return true }
    guard let rawValue = unnamedElementTypeRawValue(elementType) else { return false }
    return presentingElementTypes.values.contains(rawValue)
  }

  /// The raw element type behind the `Element(<number>)` spelling a producer uses for a type its own
  /// name table does not cover. The number has to be bare digits: `Int` accepts a leading `+`, so a
  /// numeric parse would read `Element(+5)` as Sheet, and the rule's answers would then depend on how
  /// lenient one language's integer parser happens to be.
  private static func unnamedElementTypeRawValue(_ elementType: String) -> Int? {
    guard elementType.hasPrefix(unnamedElementTypePrefix), elementType.hasSuffix(")") else { return nil }
    let digits = elementType.dropFirst(unnamedElementTypePrefix.count).dropLast()
    guard !digits.isEmpty, digits.allSatisfy({ $0.isASCII && $0.isNumber }) else { return nil }
    return Int(digits)
  }

  private static let unnamedElementTypePrefix = "Element("

  private static func isSystemWindow(_ node: PresentedSurfaceNode) -> Bool {
    guard let className = node.className.map(normalizeClassName) else { return false }
    return systemWindowClasses.contains { normalizeClassName($0) == className }
  }

  /// The app's windows: the nodes directly under its root, as the places in `nodes` they occupy. Both iOS
  /// acquisition tiers report the app root and then one node per window, so finding them needs no class
  /// facts — which is what lets a class-blind capture still be examined for the evidence it does report.
  private static func appWindowPositions(_ nodes: [PresentedSurfaceNode]) -> [Int] {
    let roots = nodes.enumerated().filter { $0.element.parentIndex == nil }.map(\.offset)
    guard roots.count == 1 else { return [] }
    let rootIndex = nodes[roots[0]].index
    return nodes.enumerated().filter { $0.element.parentIndex == rootIndex }.map(\.offset)
  }

  /// The nodes to read evidence from: every node except the ones the walk reached from a window UIKit
  /// hosts outside the app's scene, keyed by the place in `nodes` each occupies rather than by its number.
  /// A walk has to reach the node it is standing on, and two nodes sharing a number cannot be told apart
  /// by the links that reach them; keying on the number would let a keyboard host's subtree swallow an
  /// app window's own evidence, which is a direct read the rule would then throw away. Keying on the
  /// occurrence keeps that read, and the numbering guard in `classify` is what stops such a tree from
  /// earning absence. A capture with no class facts cannot single any window out, which is the honest
  /// reading: nothing in it is excludable.
  private static func positionsOutsideSystemWindows(
    _ nodes: [PresentedSurfaceNode],
    _ windowPositions: [Int]
  ) -> Set<Int> {
    var positionsByParentIndex: [Int: [Int]] = [:]
    for (position, node) in nodes.enumerated() {
      guard let parentIndex = node.parentIndex else { continue }
      positionsByParentIndex[parentIndex, default: []].append(position)
    }
    var examinable = Set(nodes.indices)
    for windowPosition in windowPositions where isSystemWindow(nodes[windowPosition]) {
      for occurrence in subtreePositions(windowPosition, in: nodes, byParentIndex: positionsByParentIndex) {
        examinable.remove(occurrence)
      }
    }
    return examinable
  }

  /// A node and everything reachable from it through parent links, as the places in `nodes` they occupy,
  /// so reported depths are not needed. Visited is keyed on the occurrence and seeded with the root: a
  /// producer that repeats an index deeper in the tree closes a loop this walk would follow forever, and
  /// the classification runs outside the runner's bounded main-thread work, so no timeout would catch the
  /// spin. The golden table's cycle case is pinned on exactly that shape, in both languages.
  private static func subtreePositions(
    _ rootPosition: Int,
    in nodes: [PresentedSurfaceNode],
    byParentIndex positionsByParentIndex: [Int: [Int]]
  ) -> [Int] {
    var collected: [Int] = [rootPosition]
    var visited: Set<Int> = [rootPosition]
    var walked = 0
    while walked < collected.count {
      for position in positionsByParentIndex[nodes[collected[walked]].index] ?? [] where visited.insert(position).inserted {
        collected.append(position)
      }
      walked += 1
    }
    return collected
  }

  private static func presentationContainers(
    of window: PresentedSurfaceNode,
    in nodes: [PresentedSurfaceNode]
  ) -> [PresentedSurfaceNode] {
    children(of: window, in: nodes).filter {
      $0.className.map(normalizeClassName) == normalizeClassName(presentationContainerClass)
    }
  }

  private static func children(
    of parent: PresentedSurfaceNode,
    in nodes: [PresentedSurfaceNode]
  ) -> [PresentedSurfaceNode] {
    nodes.filter { $0.parentIndex == parent.index }
  }
}
