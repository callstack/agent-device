import AgentDeviceSnapshotPresentation

// MARK: - Wire Models

enum CommandType: String, Codable {
  case tap
  case mouseClick
  case longPress
  case drag
  case remotePress
  case type
  case swipe
  case scroll
  case desktopScroll
  case findText
  case querySelector
  case readText
  case snapshot
  case screenshot
  case back
  case backInApp
  case backSystem
  case home
  case rotate
  case appSwitcher
  case actionButton
  case keyboardDismiss
  case keyboardReturn
  case alert
  case sequence
  case gesture
  case gestureViewport
  case recordStart
  case recordStop
  case status
  case uptime
  case activate
  case terminate
  case targetReset
  case shutdown
}

/// Runner command traits — see CONTEXT.md ("Runner command traits").
///
/// Single source of truth for how the runner classifies a command across three
/// independent axes, replacing the three hand-maintained switches that used to live
/// in RunnerTests+Lifecycle.swift (isInteractionCommand / isReadOnlyCommand /
/// isRunnerLifecycleCommand). The classification is load-bearing for ADR-0002 session
/// invalidation: `readOnly` gates the retry that nulls currentApp/currentBundleId.
struct CommandTraits {
  /// Whether the command needs the foreground-guard + stabilization preflight before running.
  let isInteraction: Bool
  /// Whether the command is eligible for the session-invalidating retry.
  /// `.conditional` is resolved against the request (alert is read-only only for its `get` action).
  let readOnly: ReadOnly
  /// Whether the command skips the app-activation preflight entirely.
  let isLifecycle: Bool

  enum ReadOnly {
    case always
    case never
    /// Alert-only today. Resolved in `isReadOnlyCommand` with alert's rule (read-only for the
    /// `get` action, mutating otherwise). A new `.conditional` command would inherit that rule
    /// until the resolver is generalized — give it explicit handling there if its semantics differ.
    case conditional
  }
}

extension CommandType {
  /// The classification for this command. Exhaustive by construction: a new CommandType
  /// cannot compile without being classified here, so commands can no longer silently drift
  /// out of classification the way the parallel switches allowed.
  var traits: CommandTraits {
    switch self {
    // Interaction commands: require the foreground-guard + stabilization preflight.
    // keyboardReturn is the sibling of keyboardDismiss (missing from the historical switch —
    // drift the table now prevents). .scroll is the fused frame-resolve + drag scroll; same
    // classification as .drag. .desktopScroll is the macOS frame-resolve + wheel event sibling.
    // .sequence is the fused multi-step gesture batch.
    case .tap, .longPress, .drag, .remotePress, .type, .swipe, .scroll, .desktopScroll,
         .back, .backInApp, .backSystem, .rotate, .appSwitcher,
         .keyboardDismiss, .keyboardReturn, .sequence, .gesture:
      return CommandTraits(isInteraction: true, readOnly: .never, isLifecycle: false)

    // Read-only reads: eligible for the session-invalidating retry.
    case .findText, .readText, .snapshot, .gestureViewport:
      return CommandTraits(isInteraction: false, readOnly: .always, isLifecycle: false)

    // Screenshot is both a read and a runner-lifecycle command (skips app-activation preflight).
    case .screenshot:
      return CommandTraits(isInteraction: false, readOnly: .always, isLifecycle: true)

    // Alert is read-only only for its `get` action (resolved by isReadOnlyCommand).
    case .alert:
      return CommandTraits(isInteraction: false, readOnly: .conditional, isLifecycle: false)

    // Runner-lifecycle commands: skip the app-activation preflight.
    case .recordStop, .uptime, .terminate, .targetReset, .shutdown:
      return CommandTraits(isInteraction: false, readOnly: .never, isLifecycle: true)

    // A hardware press mutates, is not an element interaction, and is not runner-lifecycle. It stays
    // outside the lifecycle group because that flag also exempts a command from the recorded-failure
    // conversion, and this command has no settle or post-action observation, so that conversion is
    // the only evidence the press landed. It skips the app-activation preflight on its own terms in
    // `shouldSkipAppActivationPreflight`, the way `.alert` does (#2699, #2702 review).
    case .actionButton:
      return CommandTraits(isInteraction: false, readOnly: .never, isLifecycle: false)

    case .status:
      return CommandTraits(isInteraction: false, readOnly: .always, isLifecycle: true)

    // Normal preflight, not retried.
    // NOTE: mouseClick stays non-interaction for now — it is macOS-only and the foreground
    // guard interacts with bespoke macOS activation, so classifying it needs a macOS smoke
    // check first (tracked as a follow-up). Also preserved: querySelector is NOT read-only;
    // recordStart is NOT a lifecycle command; home/alert remain non-interaction by design.
    case .mouseClick, .querySelector, .home, .recordStart, .activate:
      return CommandTraits(isInteraction: false, readOnly: .never, isLifecycle: false)
    }
  }
}

struct Command: Codable {
  let command: CommandType
  let commandId: String?
  let statusCommandId: String?
  let appBundleId: String?
  let text: String?
  let selectorKey: String?
  let selectorValue: String?
  let allowNonHittableCoordinateFallback: Bool?
  let delayMs: Int?
  let textEntryMode: String?
  let action: String?
  let x: Double?
  let y: Double?
  let button: String?
  let remoteButton: String?
  let x2: Double?
  let y2: Double?
  let durationMs: Double?
  let timeoutMs: Double?
  let direction: String?
  let amount: Double?
  let pixels: Double?
  let scrollReleaseBehavior: ScrollReleaseBehavior?
  let orientation: String?
  let gesturePlan: RunnerGesturePlan?
  let outPath: String?
  let fps: Int?
  let interactiveOnly: Bool?
  let preferredBackend: String?
  let customActions: Bool?
  let depth: Int?
  let scope: String?
  let raw: Bool?
  let fullscreen: Bool?
  let inlineScreenshot: Bool?
  let synthesized: Bool?
  let steps: [SequenceStep]?
}

enum ScrollReleaseBehavior: String, Codable {
  case controlled
  case inertial
}

/// Canonical one- or two-pointer plan produced by the portable TypeScript planner.
struct RunnerGesturePlan: Codable {
  let topology: String
  let intent: String
  let executionProfile: String?
  let durationMs: Double
  let viewport: RunnerGestureViewport
  let pointers: [RunnerGesturePointer]
}

struct RunnerGestureViewport: Codable {
  let x: Double
  let y: Double
  let width: Double
  let height: Double
}

struct RunnerGesturePointer: Codable {
  let pointerId: Int
  let samples: [RunnerGestureSample]
}

struct RunnerGestureSample: Codable {
  let offsetMs: Double
  let point: RunnerGesturePoint
}

struct RunnerGesturePoint: Codable {
  let x: Double
  let y: Double
}

/// One allowlisted coordinate gesture step inside a fused `sequence` command.
/// `kind` is decoded as a raw String (not an enum) so the runner can return a clear
/// INVALID_ARGS for an unknown kind instead of a generic decode failure.
struct SequenceStep: Codable {
  let kind: String
  let x: Double?
  let y: Double?
  let durationMs: Double?
  let pauseMs: Double?
  /// For `tap` steps on iOS non-tv: use the synthesized HID fast path instead of the
  /// drag-based XCUICoordinate path, matching the individual command behavior.
  let synthesized: Bool?
}

/// Per-step result for a `sequence` response. `ok:false` carries the failing step's
/// errorCode/errorMessage; execution stops at the first failed step.
struct SequenceStepResult: Codable {
  let ok: Bool
  let kind: String
  let errorCode: String?
  let errorMessage: String?
  let gestureStartUptimeMs: Double?
  let gestureEndUptimeMs: Double?
}

struct Response: Codable {
  let ok: Bool
  var data: DataPayload?
  var error: ErrorPayload?
}

extension Response {
  // The daemon pairs this gesture-clock anchor with its own receipt time to map
  // gesture uptimes onto wall-clock for the recording touch overlay. Error responses
  // carry no anchor so the daemon falls back instead of pairing a stale value.
  func stampingCurrentUptimeMs(_ value: Double) -> Response {
    guard ok else { return self }
    var payload = data ?? DataPayload()
    payload.currentUptimeMs = value
    return Response(ok: ok, data: payload, error: error)
  }

  // The daemon reads this occupancy flag to decide whether a healthy response proves the runner
  // drained its watchdog-abandoned main-thread work. Only successful responses carry it; a refusal
  // is itself the busy signal and needs no stamp.
  func stampingCurrentMainThreadBusy(_ value: Bool) -> Response {
    guard ok else { return self }
    var payload = data ?? DataPayload()
    payload.runnerMainThreadBusy = value
    return Response(ok: ok, data: payload, error: error)
  }

  /// The serving command had to bring the bound app back to the foreground to answer at all.
  /// Stamped on the response of that command, never on a later one (#2682). Only successful
  /// responses carry it: a refusal is already the disclosure of a command that did not run.
  func stampingTargetActivation(_ value: TargetActivationFactPayload) -> Response {
    guard ok else { return self }
    var payload = data ?? DataPayload()
    payload.targetActivation = value
    return Response(ok: ok, data: payload, error: error)
  }
}

/// Foreground repair the runner performed while serving one command (#2682). `priorState` is the
/// bound app's `XCApplicationState` raw value read BEFORE `XCUIApplication.activate()` ran, so the
/// fact describes what was repaired rather than what the repair produced. `otherActiveApplicationPid`
/// names the only other application holding an active accessibility session when exactly one existed
/// — a liveness claim, not a foreground owner, since the private AX client exposes no ordering of
/// `activeApplications`, resolves no bundle id for an arbitrary app, and reports only pids.
struct TargetActivationFactPayload: Codable {
  let reason: String
  let priorState: Int
  let otherActiveApplicationPid: Int?
}

struct DataPayload: Codable {
  var message: String?
  var imageBase64: String?
  var text: String?
  var found: Bool?
  var items: [String]?
  var nodes: [PresentedNode]?
  var truncated: Bool?
  var qualityPayload: SnapshotQualityPayload? = nil
  var snapshotQuality: SnapshotQuality?
  /// Set when the capture describes an in-place system surface, not the app itself (#2438).
  var systemSurface: SystemSurfaceProvenancePayload?
  /// The keyboard band this capture measured, when the tier that answered reads keyboards at all
  /// (#2660). Absent means the query-sweep or private-AX tier answered, and the daemon's tap guard
  /// keeps deriving the band from the tree.
  var keyboard: KeyboardBandFactPayload?
  var gestureStartUptimeMs: Double?
  var gestureEndUptimeMs: Double?
  var x: Double?
  var y: Double?
  var x2: Double?
  var y2: Double?
  var referenceWidth: Double?
  var referenceHeight: Double?
  var currentUptimeMs: Double?
  var commandId: String?
  var lifecycleState: String?
  var lifecycleCommand: String?
  var lifecycleResponseOk: Bool?
  var lifecycleResponseJson: String?
  var lifecycleErrorCode: String?
  var lifecycleErrorMessage: String?
  var lifecycleErrorHint: String?
  var visible: Bool?
  var wasVisible: Bool?
  var dismissed: Bool?
  var keyboardDismissMechanism: String?
  var orientation: String?
  var gestureFallback: String?
  var gestureFallbackMessage: String?
  var gestureFallbackHint: String?
  // Scroll keyboard avoidance evidence (#2500): the swipe was clipped to the band above an
  // on-screen keyboard, and where that band ended. `referenceHeight` already names the clipped axis.
  var keyboardAvoided: Bool?
  var keyboardMinY: Double?
  var maestroNonHittableCoordinateFallbackUsed: Bool?
  var textEntryRoute: String?
  var runnerFatal: Bool?
  var runnerFatalReason: String?
  /// Whether main-thread XCTest work past the execution watchdog is still draining when this
  /// response is written. A private-AX snapshot can be served successfully while an abandoned tree
  /// crawl still grinds, so the healthy response must carry the live occupancy rather than let the
  /// daemon read `ok` as proof the runner drained (#2552).
  var runnerMainThreadBusy: Bool?
  var completedSteps: Int?
  var failedStepIndex: Int?
  var sequenceResults: [SequenceStepResult]?
  var targetActivation: TargetActivationFactPayload?
}

/// `kind` mirrors the TS `SnapshotKeyboardBandFact`: "visible" carries `frame`, "unmeasurable"
/// carries `reason`, and "absent" carries nothing because there is nothing to say. `frame` is in the
/// app's own orientation space — the same space `SnapshotGeometrySpace` publishes every node rect in
/// — so the daemon compares it against node rects without transforming either side (#2660).
struct KeyboardBandFactPayload: Codable, Equatable {
  let kind: String
  let frame: SnapshotRect?
  let reason: String?
}

/// `kind` mirrors the TS `IosSystemSurfaceKind` (e.g. "web-auth").
struct SystemSurfaceProvenancePayload: Codable {
  let bundleId: String
  let kind: String
}

struct SnapshotQualityPayload: Codable {
  let nodes: [PresentedNode]
  let truncated: Bool
  let scope: String?

  init(nodes: [PresentedNode], truncated: Bool) {
    self.nodes = nodes
    self.truncated = truncated
    self.scope = nil
  }

  private enum CodingKeys: String, CodingKey {
    case nodes
    case truncated
    case scope
  }

  func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(nodes, forKey: .nodes)
    try container.encode(truncated, forKey: .truncated)
    try container.encodeNil(forKey: .scope)
  }
}

struct ErrorPayload: Codable {
  var code: String?
  let message: String
  var hint: String?
}
