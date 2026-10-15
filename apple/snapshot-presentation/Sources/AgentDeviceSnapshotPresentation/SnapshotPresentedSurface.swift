import Foundation

/// Reads a modal presentation out of a runner acquisition (#3565). A runner node carries no UIKit class
/// name, so the only evidence it holds is an element type that names a presentation, and its answer is
/// `presented` or `unknown`, never `absent`. This is the class-blind column of the golden table
/// `contracts/fixtures/ios-presented-surface.json`; the class-aware rule is `collectPresentedSurface` in
/// `packages/capture-kit/src/ios-snapshot-engine/geometry-policy.ts`.
public enum SnapshotPresentedSurface {
  /// Element types that name a presentation, keyed by the element-type numbering every iOS producer
  /// reads. A producer whose name table stops short publishes `Element(<number>)` for the same node.
  public static let presentingElementTypes: [String: Int] = [
    "Sheet": 5,
    "Drawer": 6,
    "Alert": 7,
    "Dialog": 8,
  ]

  public static func classify(_ acquisition: SnapshotAcquisition) -> PresentedSurface {
    acquisition.nodes.contains { isPresentingElementType($0.type) } ? .presented : .unknown
  }

  private static func isPresentingElementType(_ elementType: String) -> Bool {
    if presentingElementTypes[elementType] != nil { return true }
    guard let rawValue = unnamedElementTypeRawValue(elementType) else { return false }
    return presentingElementTypes.values.contains(rawValue)
  }

  /// The number has to be bare ASCII digits: `Int` accepts a leading `+`, so a numeric parse would read
  /// `Element(+5)` as Sheet where the TypeScript rule does not.
  private static func unnamedElementTypeRawValue(_ elementType: String) -> Int? {
    let prefix = "Element("
    guard elementType.hasPrefix(prefix), elementType.hasSuffix(")") else { return nil }
    let digits = elementType.dropFirst(prefix.count).dropLast()
    guard !digits.isEmpty, digits.allSatisfy({ $0.isASCII && $0.isNumber }) else { return nil }
    return Int(digits)
  }
}
