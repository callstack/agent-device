import AgentDeviceSnapshotPresentation
import CoreGraphics
import Foundation

private struct ConformanceInput: Decodable {
  struct Node: Decodable {
    let index: Int
    let type: String
    let label: String?
    let identifier: String?
    let value: String?
    let rect: SnapshotRect
    let enabled: Bool
    let focused: Bool?
    let selected: Bool?
    let hittable: Bool
    let depth: Int
    let parentIndex: Int?
    let hiddenContentAbove: Bool?
    let hiddenContentBelow: Bool?
  }

  let name: String
  let projection: String
  let interactiveOnly: Bool
  let depth: Int?
  let scope: String?
  let foldPolicy: String
  let viewport: SnapshotRect
  let nodes: [Node]
}

private struct BatchInput: Decodable {
  let cases: [ConformanceInput]
}

private struct ConformanceError: Encodable {
  let code: String
  let reason: String
  let message: String
}

private struct ConformanceOutput: Encodable {
  let name: String
  let outcome: String
  let nodes: [PresentedNode]
  let error: ConformanceError?
}

private struct BatchOutput: Encodable {
  let cases: [ConformanceOutput]
}

private func acquisition(for input: ConformanceInput) -> SnapshotAcquisition {
  let inputOptions = options(for: input)
  return SnapshotAcquisition(
    hint: SnapshotPresentation.captureHint(for: inputOptions),
    nodes: input.nodes.map { node in
      RawAXNode(
        index: node.index,
        type: node.type,
        label: node.label,
        identifier: node.identifier,
        value: node.value,
        rect: node.rect,
        enabled: node.enabled,
        focused: node.focused,
        selected: node.selected,
        hittable: node.hittable,
        depth: node.depth,
        parentIndex: node.parentIndex,
        hiddenContentAbove: node.hiddenContentAbove,
        hiddenContentBelow: node.hiddenContentBelow
      )
    },
    truncated: false,
    effectiveDepth: nil,
    viewport: input.viewport.cgRect
  )
}

private func options(for input: ConformanceInput) -> PresentationOptions {
  PresentationOptions(
    interactiveOnly: input.interactiveOnly,
    depth: input.depth,
    scope: input.scope,
    raw: input.projection == CaptureHint.Projection.raw.rawValue
  )
}

private func present(_ input: ConformanceInput) -> ConformanceOutput {
  do {
    let inputAcquisition = acquisition(for: input)
    let inputOptions = options(for: input)
    let nodes: [PresentedNode]
    if input.projection == CaptureHint.Projection.raw.rawValue {
      nodes = SnapshotPresentation.presentRaw(inputAcquisition, options: inputOptions).nodes
    } else {
      let policy: SnapshotVisibilityFold.Policy = input.foldPolicy == "plain-viewport"
        ? .plainViewport
        : .cursorProjected
      nodes = try SnapshotPresentation.presentRegular(
        inputAcquisition,
        options: inputOptions,
        policy: policy
      ).nodes
    }
    return ConformanceOutput(name: input.name, outcome: "success", nodes: nodes, error: nil)
  } catch let failure as SnapshotPresentationFailure {
    return ConformanceOutput(
      name: input.name,
      outcome: "failure",
      nodes: [],
      error: ConformanceError(
        code: failure.code,
        reason: reason(for: failure),
        message: failure.message
      )
    )
  } catch {
    return ConformanceOutput(
      name: input.name,
      outcome: "failure",
      nodes: [],
      error: ConformanceError(
        code: "IOS_SNAPSHOT_PRESENTATION_FAILED",
        reason: "unexpected",
        message: String(describing: error)
      )
    )
  }
}

private func reason(for failure: SnapshotPresentationFailure) -> String {
  switch failure {
  case .regularNodeOutsideCumulativeClip:
    return "regular-node-outside-cumulative-clip"
  case .regularDegenerateNodeIsActionable:
    return "regular-degenerate-actionable-node"
  }
}

private let input = try JSONDecoder().decode(
  BatchInput.self,
  from: FileHandle.standardInput.readDataToEndOfFile()
)
private let output = try JSONEncoder().encode(
  BatchOutput(cases: input.cases.map(present))
)
FileHandle.standardOutput.write(output)
FileHandle.standardOutput.write(Data([0x0a]))
