import XCTest

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
// MARK: - Shared AX recovery conformance (runner adapter)

/// Runner-side adapter for `contracts/fixtures/ios-ax-recovery-conformance.json`. The fixture's
/// synthetic native world is replayed through a fake AX client against the real bridge capture,
/// depth ladder, completeness verdict, and accepted-depth memory; the fixture's `runner` column
/// holds the expectations, and its `differences` section explains where the host bridge answers
/// differently on purpose.
private struct AXRecoveryFixture: Decodable {
  struct Fan: Decodable {
    let at: Int
    let count: Int
    let chain: Int
  }

  struct Tree: Decodable {
    let chain: Int
    let fan: Fan?
  }

  struct Request: Decodable {
    let traversalDepth: Int
    let explicitDepth: Bool
    let nodeBudget: Int
    let hint: [String: Int?]?
  }

  struct Native: Decodable {
    let tree: Tree
    let rejectLevelsAbove: Int?
    let vanishAtFrontier: Bool?
    let deadlineAfterRequests: Int?
  }

  struct Expected: Decodable {
    let outcome: String
    let failure: String?
    let requests: Int?
    let rejected: Int?
    let continuations: Int?
    let deepestLevel: Int?
    let tree: String?
    let nodes: Int?
  }

  struct RecoveryCase: Decodable {
    let name: String
    let request: Request
    let native: Native
    let expected: [String: Expected]
  }

  struct Target: Decodable {
    let id: String
    let generation: String
  }

  struct Outcome: Decodable {
    let failure: String?
    let rejected: [String: Int]
    let acceptedLevels: [String: Int]?
    let complete: Bool?
  }

  struct HintStep: Decodable {
    let expire: Bool?
    let target: Target?
    let explicitDepth: Bool?
    let expectHintBefore: [String: Int?]?
    let outcome: Outcome?
    let expectHintAfter: [String: Int?]?
    let expectRenewed: Bool?
  }

  struct HintCase: Decodable {
    let name: String
    let steps: [HintStep]
  }

  let version: Int
  let recoveryCases: [RecoveryCase]
  let hintCases: [HintCase]
}

private final class AXFixtureNode {
  let level: Int
  let identity: String
  private(set) weak var parent: AXFixtureNode?
  var children: [AXFixtureNode] = []

  init(level: Int, identity: String, parent: AXFixtureNode?) {
    self.level = level
    self.identity = identity
    self.parent = parent
  }

  var branch: String { identity.split(separator: ".").count > 1 ? String(identity.split(separator: ".")[1]) : "" }

  static func build(_ tree: AXRecoveryFixture.Tree) -> AXFixtureNode {
    let root = AXFixtureNode(level: 0, identity: "0", parent: nil)
    let tail = root.extend(by: tree.chain - 1, branch: nil)
    if let fan = tree.fan {
      precondition(fan.at == tail.level, "the fan must hang off the last chain node")
      for branch in 0..<fan.count {
        let head = AXFixtureNode(level: tail.level + 1, identity: "\(tail.level + 1).\(branch)", parent: tail)
        tail.children.append(head)
        _ = head.extend(by: fan.chain, branch: "\(branch)")
      }
    }
    return root
  }

  /// Every node by identity, so a delivered tree can be checked against canonical parents.
  func index() -> [String: AXFixtureNode] {
    var result: [String: AXFixtureNode] = [:]
    var queue = [self]
    while let node = queue.first {
      queue.removeFirst()
      result[node.identity] = node
      queue.append(contentsOf: node.children)
    }
    return result
  }

  private func extend(by count: Int, branch: String?) -> AXFixtureNode {
    var current = self
    for _ in 0..<count {
      let level = current.level + 1
      let identity = branch.map { "\(level).\($0)" } ?? "\(level)"
      let next = AXFixtureNode(level: level, identity: identity, parent: current)
      current.children.append(next)
      current = next
    }
    return current
  }
}

/// The live accessibility element a frontier snapshot resolves to; carries its fixture node so a
/// re-rooted request can answer from the same synthetic tree.
private final class AXFixtureElement: NSObject {
  let node: AXFixtureNode
  init(node: AXFixtureNode) { self.node = node }
}

/// One serialized native fragment node, KVC-readable the way the bridge reads XCElementSnapshot.
private final class AXFixtureSnapshot: NSObject {
  @objc let elementType: NSNumber = 0
  @objc let identifier: String
  @objc let label: String
  @objc let value: String? = nil
  @objc let frame: NSValue? = nil
  @objc let enabled: NSNumber = true
  @objc let selected: NSNumber = false
  @objc let hasFocus: NSNumber = false
  @objc let children: [AXFixtureSnapshot]
  @objc let accessibilityElement: AXFixtureElement?

  init(node: AXFixtureNode, children: [AXFixtureSnapshot], element: AXFixtureElement?) {
    identifier = node.identity
    label = node.identity
    self.children = children
    accessibilityElement = element
  }

  /// `levels` node levels rooted at `node`; the deepest returned level loses its live element
  /// when the fixture says the frontier vanished.
  static func fragment(_ node: AXFixtureNode, levels: Int, vanishAtFrontier: Bool) -> AXFixtureSnapshot {
    let boundary = levels <= 1
    let children = boundary
      ? []
      : node.children.map { fragment($0, levels: levels - 1, vanishAtFrontier: vanishAtFrontier) }
    return AXFixtureSnapshot(
      node: node,
      children: children,
      element: boundary && vanishAtFrontier ? nil : AXFixtureElement(node: node))
  }
}

/// Stands in for the private AX client: answers `requestSnapshotForElement:` from the synthetic
/// tree and rejects requests deeper than the fixture's native limit the way the AX server does.
private final class AXFixtureClient: NSObject {
  private let rejectLevelsAbove: Int?
  private let vanishAtFrontier: Bool
  private(set) var requests = 0
  private(set) var rejected = 0

  init(rejectLevelsAbove: Int?, vanishAtFrontier: Bool) {
    self.rejectLevelsAbove = rejectLevelsAbove
    self.vanishAtFrontier = vanishAtFrontier
  }

  @objc(requestSnapshotForElement:attributes:parameters:error:)
  func requestSnapshot(
    forElement element: Any, attributes: Any, parameters: [String: Any], error: NSErrorPointer
  ) -> Any? {
    requests += 1
    let levels = (parameters["maxDepth"] as? NSNumber)?.intValue ?? 0
    if let limit = rejectLevelsAbove, levels > limit {
      rejected += 1
      error?.pointee = NSError(
        domain: "AX", code: -25201,
        userInfo: [NSLocalizedDescriptionKey: "Error kAXErrorIllegalArgument"])
      return nil
    }
    guard let element = element as? AXFixtureElement else { return nil }
    return AXFixtureSnapshot.fragment(element.node, levels: levels, vanishAtFrontier: vanishAtFrontier)
  }
}

private struct AXRecoveryObservation {
  var outcome = ""
  var failure: String?
  var requests = 0
  var rejected = 0
  var continuations = 0
  var deepestLevel: Int?
  var tree: String?
  var nodes: Int?
}

/// One ladder capture of the synthetic world through the real bridge: what the memory
/// characterization observes before it hands the result to the runner's own learning step.
private struct AXLadderObservation {
  let succeeded: Bool
  let rejected: Int
  let effectiveDepth: Int
  let truncated: Bool
  let attemptDepths: [Int]
}

extension RunnerTests {
  private static func loadAXRecoveryFixture() throws -> AXRecoveryFixture {
    let fixtureURL = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent() // UnitTests
      .deletingLastPathComponent() // AgentDeviceRunnerUITests
      .deletingLastPathComponent() // AgentDeviceRunner
      .deletingLastPathComponent() // runner
      .deletingLastPathComponent() // apple
      .deletingLastPathComponent() // repo root
      .appendingPathComponent("contracts")
      .appendingPathComponent("fixtures")
      .appendingPathComponent("ios-ax-recovery-conformance.json")
    let fixture = try JSONDecoder().decode(AXRecoveryFixture.self, from: Data(contentsOf: fixtureURL))
    XCTAssertEqual(fixture.version, 1)
    return fixture
  }

  private static func fixtureHint(_ hints: [String: Int?]?, _ producer: String) -> Int? {
    hints?[producer] ?? nil
  }

  private static func identityLevel(_ identity: String) -> Int {
    Int(identity.split(separator: ".").first ?? "") ?? 0
  }

  private static func identityBranch(_ identity: String) -> String {
    let parts = identity.split(separator: ".")
    return parts.count > 1 ? String(parts[1]) : ""
  }

  /// The canonical signature described by the fixture's `nativeModel.signature`: preorder
  /// identities, `<parent` when a node hangs off a non-canonical parent, and `first-last` for a
  /// run of consecutive levels on one branch. Bounded by the bridge's node limit so a cyclic or
  /// shared subtree reads as an oversized signature, not as a hang.
  private static func treeSignature(_ root: [String: Any]?, index: [String: AXFixtureNode]) -> (tree: String, nodes: Int)? {
    guard let root else { return nil }
    var preorder: [(identity: String, parent: String)] = []
    func collect(_ node: [String: Any], parent: String) {
      guard preorder.count < 10_000 else { return }
      let identity = node["label"] as? String ?? ""
      preorder.append((identity, parent))
      for child in node["children"] as? [[String: Any]] ?? [] { collect(child, parent: identity) }
    }
    collect(root, parent: "")
    var tokens: [String] = []
    var runStart: String?
    var runLast: String?
    func flush() {
      if let start = runStart, let last = runLast { tokens.append(start == last ? start : "\(start)-\(last)") }
      runStart = nil
      runLast = nil
    }
    for entry in preorder {
      let canonicalParent = index[entry.identity]?.parent?.identity ?? ""
      if entry.parent != canonicalParent {
        flush()
        tokens.append("\(entry.identity)<\(entry.parent)")
        continue
      }
      if let last = runLast, entry.parent == last, identityBranch(entry.identity) == identityBranch(last),
        identityLevel(entry.identity) == identityLevel(last) + 1
      {
        runLast = entry.identity
        continue
      }
      flush()
      runStart = entry.identity
      runLast = entry.identity
    }
    flush()
    return (tokens.joined(separator: ","), preorder.count)
  }

  private static func deepestLevel(_ node: [String: Any]?) -> Int? {
    guard let node else { return nil }
    let own = (node["label"] as? String).map(identityLevel)
    let children = (node["children"] as? [[String: Any]] ?? []).compactMap(deepestLevel)
    return ([own].compactMap { $0 } + children).max()
  }

  private func observePrivateAXRecovery(_ recoveryCase: AXRecoveryFixture.RecoveryCase)
    -> AXRecoveryObservation
  {
    let request = recoveryCase.request
    let native = recoveryCase.native
    let rootNode = AXFixtureNode.build(native.tree)
    let root = AXFixtureElement(node: rootNode)
    let client = AXFixtureClient(
      rejectLevelsAbove: native.rejectLevelsAbove, vanishAtFrontier: native.vanishAtFrontier ?? false)
    let explicit = request.explicitDepth
    let attemptDepths = Self.privateAXAttemptDepths(
      requestedDepth: request.traversalDepth,
      rememberedDepth: explicit ? nil : Self.fixtureHint(request.hint, "runner"))
    XCTAssertTrue(
      native.deadlineAfterRequests == nil || native.deadlineAfterRequests == 1,
      "\(recoveryCase.name): the runner adapter models a deadline spent after the first request")
    let deadline: Date = native.deadlineAfterRequests == 1 ? Date() : .distantFuture
    let ladder = Self.privateAXLadderCapture(attemptDepths: attemptDepths, deadline: deadline) { depth in
      RunnerAXSnapshotBridge.snapshotTree(
        withClient: client,
        target: root,
        maxDepth: depth,
        maxNodes: request.nodeBudget,
        deepExtensionCallLimit: explicit ? 0 : Self.privateAXDeepExtensionCallLimit,
        customActionLimit: 0,
        deadline: deadline)
    }

    var observation = AXRecoveryObservation()
    observation.requests = client.requests
    observation.rejected = client.rejected
    let extension_ = ladder.response[RunnerAXSnapshotDeepExtensionKey] as? [String: Any]
    observation.continuations = extension_?[RunnerAXSnapshotDeepExtensionCallsKey] as? Int ?? 0
    guard ladder.succeeded else {
      observation.outcome = "failed"
      observation.failure = ladder.deadlineSpent ? "deadline" : "rejected"
      return observation
    }
    let depthLimited = Self.privateAXDepthLimited(
      effectiveDepth: ladder.effectiveDepth,
      requestedDepth: request.traversalDepth,
      pendingFrontiers: extension_?[RunnerAXSnapshotDeepExtensionPendingKey] as? Int,
      missedFrontiers: extension_?[RunnerAXSnapshotDeepExtensionMissedKey] as? Int)
    let truncated = ladder.response["truncated"] as? Bool == true
    observation.outcome = depthLimited || truncated ? "incomplete" : "complete"
    let root_ = ladder.response["root"] as? [String: Any]
    observation.deepestLevel = Self.deepestLevel(root_)
    if let signature = Self.treeSignature(root_, index: rootNode.index()) {
      observation.tree = signature.tree
      observation.nodes = signature.nodes
    }
    return observation
  }

  /// Every recovery case of the shared fixture, replayed through the real ladder, bridge
  /// capture, frontier extension, and completeness verdict, down to the delivered tree.
  func testPrivateAXRecoveryMatchesSharedFixture() throws {
    let fixture = try Self.loadAXRecoveryFixture()
    XCTAssertFalse(fixture.recoveryCases.isEmpty)
    for recoveryCase in fixture.recoveryCases {
      let expected = try XCTUnwrap(recoveryCase.expected["runner"], recoveryCase.name)
      if expected.outcome == "not-applicable" { continue }
      let observed = observePrivateAXRecovery(recoveryCase)
      let name = recoveryCase.name
      XCTAssertEqual(observed.outcome, expected.outcome, "\(name): outcome")
      XCTAssertEqual(observed.failure, expected.failure, "\(name): failure")
      XCTAssertEqual(observed.requests, expected.requests, "\(name): requests")
      XCTAssertEqual(observed.rejected, expected.rejected, "\(name): rejected")
      XCTAssertEqual(observed.continuations, expected.continuations, "\(name): continuations")
      XCTAssertEqual(observed.deepestLevel, expected.deepestLevel, "\(name): deepestLevel")
      XCTAssertEqual(observed.tree, expected.tree, "\(name): tree")
      XCTAssertEqual(observed.nodes, expected.nodes, "\(name): nodes")
    }
  }

  /// One hint step's capture: a chain that fits the accepted rung when the step is complete, or
  /// a longer chain under a node budget of that rung when it is bounded, captured through the
  /// real ladder against a client that rejects anything deeper than the accepted rung.
  private func observePrivateAXHintCapture(
    _ outcome: AXRecoveryFixture.Outcome, remembered: Int?, explicit: Bool
  ) throws -> AXLadderObservation {
    // A failing step is rejected at every depth; otherwise the chain fits the accepted rung, or
    // overflows a node budget of that rung when the step is bounded.
    let failing = outcome.failure != nil
    let accepted = failing ? 0 : try XCTUnwrap(outcome.acceptedLevels?["runner"])
    let complete = outcome.complete ?? true
    let tree = AXRecoveryFixture.Tree(chain: failing ? 5 : complete ? max(1, accepted - 1) : accepted + 5, fan: nil)
    let root = AXFixtureElement(node: AXFixtureNode.build(tree))
    let client = AXFixtureClient(rejectLevelsAbove: accepted, vanishAtFrontier: false)
    let attemptDepths = Self.privateAXAttemptDepths(requestedDepth: 64, rememberedDepth: remembered)
    let ladder = Self.privateAXLadderCapture(attemptDepths: attemptDepths, deadline: .distantFuture) { depth in
      RunnerAXSnapshotBridge.snapshotTree(
        withClient: client,
        target: root,
        maxDepth: depth,
        maxNodes: complete ? 1_500 : max(1, accepted),
        deepExtensionCallLimit: explicit ? 0 : Self.privateAXDeepExtensionCallLimit,
        customActionLimit: 0,
        deadline: .distantFuture)
    }
    return AXLadderObservation(
      succeeded: ladder.succeeded,
      rejected: client.rejected,
      effectiveDepth: ladder.effectiveDepth,
      truncated: ladder.response["truncated"] as? Bool == true,
      attemptDepths: attemptDepths)
  }

  /// Every hint case of the shared fixture, replayed as real captures whose outcome feeds the
  /// runner's own learning step: the fixture's target id is the bundle id and its generation is
  /// the process identifier.
  func testPrivateAXAcceptedDepthMemoryMatchesSharedFixture() throws {
    let fixture = try Self.loadAXRecoveryFixture()
    XCTAssertFalse(fixture.hintCases.isEmpty)
    defer {
      clearPrivateAXAcceptedDepth(reason: "test-cleanup")
      currentBundleId = nil
      currentAppProcessIdentifier = nil
    }
    for hintCase in fixture.hintCases {
      clearPrivateAXAcceptedDepth(reason: "fixture-case")
      for step in hintCase.steps {
        if step.expire == true {
          privateAXAcceptedDepthUntil = Date(timeIntervalSinceNow: -1)
          continue
        }
        let name = hintCase.name
        let target = try XCTUnwrap(step.target, name)
        let processIdentifier = try XCTUnwrap(
          Int(target.generation.filter(\.isNumber)), "\(name): generation must end in digits")
        currentBundleId = target.id
        currentAppProcessIdentifier = processIdentifier
        let explicit = step.explicitDepth ?? false
        let remembered =
          explicit
          ? nil
          : rememberedPrivateAXAcceptedDepth(bundleId: target.id, processIdentifier: processIdentifier)
        XCTAssertEqual(remembered, Self.fixtureHint(step.expectHintBefore, "runner"), "\(name): before")

        let outcome = try XCTUnwrap(step.outcome, name)
        let capture = try observePrivateAXHintCapture(outcome, remembered: remembered, explicit: explicit)
        XCTAssertEqual(capture.succeeded, outcome.failure == nil, "\(name): capture")
        XCTAssertEqual(capture.rejected, outcome.rejected["runner"], "\(name): rejected")
        let expiryBefore = privateAXAcceptedDepthUntil
        if capture.succeeded {
          XCTAssertEqual(capture.effectiveDepth, outcome.acceptedLevels?["runner"], "\(name): accepted rung")
          XCTAssertEqual(capture.truncated, outcome.complete == false, "\(name): bounded")
          // The production path records only after a successful ladder, exactly like this.
          recordPrivateAXAcceptedDepth(
            exactDepthRequested: explicit,
            effectiveDepth: capture.effectiveDepth,
            attemptDepths: capture.attemptDepths)
        }
        XCTAssertEqual(
          rememberedPrivateAXAcceptedDepth(bundleId: target.id, processIdentifier: processIdentifier),
          Self.fixtureHint(step.expectHintAfter, "runner"),
          "\(name): after")
        if step.expectRenewed == false {
          XCTAssertEqual(privateAXAcceptedDepthUntil, expiryBefore, "\(name): renewed")
        }
      }
    }
  }
}
#endif
