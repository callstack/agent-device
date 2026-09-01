import AppKit
import ApplicationServices
import Foundation

private struct RawTraversalState {
  var nodes: [SpikeNode] = []
  var visited: [AXUIElement] = []
  var maxDepth = 0
  var hitNodeLimit = false
  var hitDepthLimit = false
}

func capturePublicAccessibility(request: SpikeRequest) -> SpikeCapture {
  guard request.version == 1, request.candidate == "public-macos-ax" else {
    return unsupportedCapture(code: "candidate-not-supported")
  }
  guard AXIsProcessTrusted() else {
    return unsupportedCapture(code: "host-accessibility-permission")
  }
  guard let application = targetApplication(request: request) else {
    return unsupportedCapture(code: "target-application-unavailable")
  }

  let generation = targetGeneration(application)
  if let expected = request.expectedTargetGeneration, expected != generation {
    return SpikeCapture(
      acquisition: nil,
      failure: SpikeFailure(
        kind: "stale-generation",
        code: "target-generation-mismatch",
        expectedTargetGeneration: expected,
        observedTargetGeneration: generation
      ),
      maxTraversalDepth: 0
    )
  }

  let applicationElement = AXUIElementCreateApplication(application.processIdentifier)
  let windows = axWindows(applicationElement)
  guard !windows.isEmpty else {
    return unsupportedCapture(
      code: "target-has-no-accessibility-windows",
      observedTargetGeneration: generation
    )
  }

  var state = RawTraversalState()
  _ = appendRawNode(
    applicationElement,
    parentId: nil,
    depth: 0,
    limits: request.limits,
    state: &state
  )
  let viewport = windows.compactMap { axRect($0) }.first.map {
    SpikeViewport(
      kind: "reported",
      rect: $0,
      reason: nil,
      coordinateSpace: "host-screen",
      source: "AXPosition+AXSize"
    )
  } ?? SpikeViewport(
    kind: "missing",
    rect: nil,
    reason: "not-provided",
    coordinateSpace: nil,
    source: nil
  )
  var residue: [SpikeResidue] = []
  if state.hitNodeLimit {
    residue.append(
      SpikeResidue(
        kind: "truncated",
        fields: nil,
        dimension: "nodes",
        limit: request.limits.maxNodes,
        fact: nil,
        expected: nil,
        observed: nil
      )
    )
  }
  if state.hitDepthLimit {
    residue.append(
      SpikeResidue(
        kind: "truncated",
        fields: nil,
        dimension: "depth",
        limit: request.limits.maxTraversalDepth,
        fact: nil,
        expected: nil,
        observed: nil
      )
    )
  }
  if viewport.kind == "missing" {
    residue.append(
      SpikeResidue(
        kind: "missing-viewport",
        fields: nil,
        dimension: nil,
        limit: nil,
        fact: nil,
        expected: nil,
        observed: nil
      )
    )
  }
  return SpikeCapture(
    acquisition: SpikeAcquisition(
      targetId: "simulator:\(request.simulatorUdid)",
      targetGeneration: generation,
      nodes: state.nodes,
      viewport: viewport,
      truncated: state.hitNodeLimit || state.hitDepthLimit,
      residue: residue
    ),
    failure: nil,
    maxTraversalDepth: state.maxDepth
  )
}

private func targetApplication(request: SpikeRequest) -> NSRunningApplication? {
  if let processId = request.targetProcessId,
     let application = NSRunningApplication(processIdentifier: processId),
     !application.isTerminated
  {
    return application
  }
  return NSRunningApplication.runningApplications(
    withBundleIdentifier: request.appBundleId
  ).first(where: { !$0.isTerminated })
}

private func targetGeneration(_ application: NSRunningApplication) -> String {
  let launch = application.launchDate?.timeIntervalSince1970.description ?? "unknown"
  return "pid:\(application.processIdentifier):launch:\(launch)"
}

@discardableResult
private func appendRawNode(
  _ element: AXUIElement,
  parentId: String?,
  depth: Int,
  limits: SpikeLimits,
  state: inout RawTraversalState
) -> String? {
  if state.visited.contains(where: { CFEqual($0, element) }) { return nil }
  guard state.nodes.count < limits.maxNodes else {
    state.hitNodeLimit = true
    return nil
  }
  state.visited.append(element)
  state.maxDepth = max(state.maxDepth, depth)
  let id = "n\(state.nodes.count)"
  state.nodes.append(
    SpikeNode(
      id: id,
      parentId: parentId,
      role: axString(element, kAXRoleAttribute as String),
      subrole: axString(element, kAXSubroleAttribute as String),
      label: axString(element, kAXTitleAttribute as String)
        ?? axString(element, kAXDescriptionAttribute as String),
      value: axString(element, kAXValueAttribute as String),
      identifier: axString(element, "AXIdentifier"),
      frame: axRect(element),
      enabled: axBool(element, kAXEnabledAttribute as String),
      selected: axBool(element, kAXSelectedAttribute as String),
      focused: axBool(element, kAXFocusedAttribute as String)
    )
  )
  guard depth < limits.maxTraversalDepth else {
    if !axChildren(element).isEmpty { state.hitDepthLimit = true }
    return id
  }
  for child in axChildren(element) {
    _ = appendRawNode(
      child,
      parentId: id,
      depth: depth + 1,
      limits: limits,
      state: &state
    )
  }
  return id
}

private func axWindows(_ element: AXUIElement) -> [AXUIElement] {
  axElements(element, attribute: kAXWindowsAttribute as String)
}

private func axChildren(_ element: AXUIElement) -> [AXUIElement] {
  axElements(element, attribute: kAXChildrenAttribute as String)
}

private func axElements(_ element: AXUIElement, attribute: String) -> [AXUIElement] {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success,
        let elements = value as? [AXUIElement]
  else {
    return []
  }
  return elements
}

private func axString(_ element: AXUIElement, _ attribute: String) -> String? {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success,
        let text = value as? String
  else {
    return nil
  }
  let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
  return trimmed.isEmpty ? nil : trimmed
}

private func axBool(_ element: AXUIElement, _ attribute: String) -> Bool? {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success,
        let number = value as? NSNumber
  else {
    return nil
  }
  return number.boolValue
}

private func axRect(_ element: AXUIElement) -> SpikeRect? {
  var positionValue: CFTypeRef?
  var sizeValue: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &positionValue) == .success,
        AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeValue) == .success,
        let position = axPoint(positionValue),
        let size = axSize(sizeValue)
  else {
    return nil
  }
  return SpikeRect(
    x: Double(position.x),
    y: Double(position.y),
    width: Double(size.width),
    height: Double(size.height)
  )
}

private func axPoint(_ value: CFTypeRef?) -> CGPoint? {
  guard let value, CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
  let axValue = value as! AXValue
  guard AXValueGetType(axValue) == .cgPoint else { return nil }
  var point = CGPoint.zero
  return AXValueGetValue(axValue, .cgPoint, &point) ? point : nil
}

private func axSize(_ value: CFTypeRef?) -> CGSize? {
  guard let value, CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
  let axValue = value as! AXValue
  guard AXValueGetType(axValue) == .cgSize else { return nil }
  var size = CGSize.zero
  return AXValueGetValue(axValue, .cgSize, &size) ? size : nil
}
