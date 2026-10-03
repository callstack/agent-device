import XCTest
import AgentDeviceSnapshotPresentation

/// Reported facts for one private-AX element, read once so every consumer describes a node the
/// same way.
struct PrivateAXFields {
  let rect: CGRect
  let label: String
  let identifier: String
  let value: String
  let placeholder: String
  let rawType: Int
  let elementType: XCUIElement.ElementType?
  let enabled: Bool
  let focused: Bool?
  let selected: Bool?
  let actions: [String]?
  let children: [[String: Any]]
}

extension RunnerTests {
  /// Private-AX acquisition: ONE serializer for both projections. Reported facts at traversal
  /// depth -- membership, the clip fold, scroll hints, and collapsed depth are
  /// `SnapshotPresentation`'s alone (#1797). The traversal-depth cut is the backend's one
  /// narrowing, complete for raw (raw depth *is* traversal depth) and a declared residue for
  /// regular; the frame carried here is the one the platform reported, and
  /// `SnapshotGeometrySpace.normalized` turns it once, after this walk, before presentation (#2661).
  func privateAXAcquisition(
    rawRoot: [String: Any],
    hint: CaptureHint
  ) -> [RawAXNode] {
    var nodes: [RawAXNode] = []
    appendPrivateAXNode(rawRoot, to: &nodes, hint: hint, depth: 0, parentIndex: nil)
    return nodes
  }

  private func appendPrivateAXNode(_ raw: [String: Any], to nodes: inout [RawAXNode],
    hint: CaptureHint, depth: Int, parentIndex: Int?)
  {
    if let limit = hint.rawTraversalDepth, depth > limit { return }
    let fields = privateAXFields(raw)
    let index = nodes.count
    nodes.append(privateAXNode(fields, index: index, depth: depth, parentIndex: parentIndex))
    for child in fields.children {
      appendPrivateAXNode(child, to: &nodes, hint: hint, depth: depth + 1, parentIndex: index)
    }
  }

  private func privateAXFields(_ raw: [String: Any]) -> PrivateAXFields {
    let rawType = privateAXPresentationInt(raw["type"]) ?? 0
    return PrivateAXFields(
      rect: privateAXRect(raw["frame"]),
      label: privateAXPresentationString(raw["label"]),
      identifier: privateAXPresentationString(raw["identifier"]),
      value: privateAXPresentationString(raw["value"]),
      placeholder: privateAXPresentationString(raw["placeholder"]),
      rawType: rawType,
      elementType: privateAXElementType(rawElementType: rawType),
      enabled: privateAXPresentationBool(raw["enabled"]) ?? true,
      focused: privateAXPresentationBool(raw["focused"]) == true ? true : nil,
      selected: privateAXPresentationBool(raw["selected"]) == true ? true : nil,
      actions: raw["actions"] as? [String],
      children: raw["children"] as? [[String: Any]] ?? []
    )
  }

  private func privateAXNode(_ fields: PrivateAXFields, index: Int, depth: Int,
    parentIndex: Int?) -> RawAXNode
  {
    return RawAXNode(index: index,
      type: fields.elementType.map(elementTypeName) ?? "Element(\(fields.rawType))",
      label: fields.label.isEmpty ? nil : fields.label,
      identifier: fields.identifier.isEmpty ? nil : fields.identifier,
      value: fields.value.isEmpty ? nil : fields.value,
      placeholder: fields.placeholder.isEmpty ? nil : fields.placeholder,
      rect: SnapshotRect(fields.rect), enabled: fields.enabled,
      focused: fields.focused, selected: fields.selected,
      hittable: false,
      depth: depth, parentIndex: parentIndex, hiddenContentAbove: nil, hiddenContentBelow: nil,
      actions: fields.actions)
  }

  private func privateAXPresentationString(_ value: Any?) -> String {
    guard let value else { return "" }
    return (value as? String ?? String(describing: value))
      .trimmingCharacters(in: .whitespacesAndNewlines)
  }
  private func privateAXPresentationInt(_ value: Any?) -> Int? {
    (value as? Int) ?? (value as? NSNumber)?.intValue
  }
  private func privateAXPresentationBool(_ value: Any?) -> Bool? {
    (value as? Bool) ?? (value as? NSNumber)?.boolValue
  }
}
