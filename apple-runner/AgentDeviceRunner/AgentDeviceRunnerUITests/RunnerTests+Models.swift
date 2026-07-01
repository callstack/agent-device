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
  case keyboardDismiss
  case keyboardReturn
  case alert
  case pinch
  case sequence
  case rotateGesture
  case transformGesture
  case recordStart
  case recordStop
  case status
  case uptime
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
         .keyboardDismiss, .keyboardReturn, .pinch, .sequence, .rotateGesture, .transformGesture:
      return CommandTraits(isInteraction: true, readOnly: .never, isLifecycle: false)

    // Read-only reads: eligible for the session-invalidating retry.
    case .findText, .readText, .snapshot:
      return CommandTraits(isInteraction: false, readOnly: .always, isLifecycle: false)

    // Screenshot is both a read and a runner-lifecycle command (skips app-activation preflight).
    case .screenshot:
      return CommandTraits(isInteraction: false, readOnly: .always, isLifecycle: true)

    // Alert is read-only only for its `get` action (resolved by isReadOnlyCommand).
    case .alert:
      return CommandTraits(isInteraction: false, readOnly: .conditional, isLifecycle: false)

    // Runner-lifecycle commands: skip the app-activation preflight.
    case .recordStop, .uptime, .shutdown:
      return CommandTraits(isInteraction: false, readOnly: .never, isLifecycle: true)

    case .status:
      return CommandTraits(isInteraction: false, readOnly: .always, isLifecycle: true)

    // Normal preflight, not retried.
    // NOTE: mouseClick stays non-interaction for now — it is macOS-only and the foreground
    // guard interacts with bespoke macOS activation, so classifying it needs a macOS smoke
    // check first (tracked as a follow-up). Also preserved: querySelector is NOT read-only;
    // recordStart is NOT a lifecycle command; home/alert remain non-interaction by design.
    case .mouseClick, .querySelector, .home, .recordStart:
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
  let clearFirst: Bool?
  let action: String?
  let x: Double?
  let y: Double?
  let button: String?
  let remoteButton: String?
  let x2: Double?
  let y2: Double?
  let dx: Double?
  let dy: Double?
  let durationMs: Double?
  let direction: String?
  let amount: Double?
  let pixels: Double?
  let orientation: String?
  let scale: Double?
  let degrees: Double?
  let velocity: Double?
  let outPath: String?
  let fps: Int?
  let maxSize: Int?
  let interactiveOnly: Bool?
  let depth: Int?
  let scope: String?
  let raw: Bool?
  let fullscreen: Bool?
  let synthesized: Bool?
  let steps: [SequenceStep]?
}

/// One allowlisted coordinate gesture step inside a fused `sequence` command.
/// `kind` is decoded as a raw String (not an enum) so the runner can return a clear
/// INVALID_ARGS for an unknown kind instead of a generic decode failure.
struct SequenceStep: Codable {
  let kind: String
  let x: Double?
  let y: Double?
  let x2: Double?
  let y2: Double?
  let durationMs: Double?
  let pauseMs: Double?
  /// For `tap`/`drag` steps on iOS non-tv: use the synthesized HID fast path instead of the
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
  let data: DataPayload?
  let error: ErrorPayload?

  init(ok: Bool, data: DataPayload? = nil, error: ErrorPayload? = nil) {
    self.ok = ok
    self.data = data
    self.error = error
  }
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
}

struct DataPayload: Codable {
  let message: String?
  let text: String?
  let found: Bool?
  let items: [String]?
  let nodes: [SnapshotNode]?
  let truncated: Bool?
  let snapshotQuality: SnapshotQuality?
  let gestureStartUptimeMs: Double?
  let gestureEndUptimeMs: Double?
  let x: Double?
  let y: Double?
  let x2: Double?
  let y2: Double?
  let referenceWidth: Double?
  let referenceHeight: Double?
  var currentUptimeMs: Double?
  let commandId: String?
  let lifecycleState: String?
  let lifecycleCommand: String?
  let lifecycleResponseOk: Bool?
  let lifecycleResponseJson: String?
  let lifecycleErrorCode: String?
  let lifecycleErrorMessage: String?
  let lifecycleErrorHint: String?
  let visible: Bool?
  let wasVisible: Bool?
  let dismissed: Bool?
  let orientation: String?
  let gestureFallback: String?
  let gestureFallbackMessage: String?
  let gestureFallbackHint: String?
  let runnerFatal: Bool?
  let runnerFatalReason: String?
  let completedSteps: Int?
  let failedStepIndex: Int?
  let sequenceResults: [SequenceStepResult]?

  init(
    message: String? = nil,
    text: String? = nil,
    found: Bool? = nil,
    items: [String]? = nil,
    nodes: [SnapshotNode]? = nil,
    truncated: Bool? = nil,
    snapshotQuality: SnapshotQuality? = nil,
    gestureStartUptimeMs: Double? = nil,
    gestureEndUptimeMs: Double? = nil,
    x: Double? = nil,
    y: Double? = nil,
    x2: Double? = nil,
    y2: Double? = nil,
    referenceWidth: Double? = nil,
    referenceHeight: Double? = nil,
    currentUptimeMs: Double? = nil,
    commandId: String? = nil,
    lifecycleState: String? = nil,
    lifecycleCommand: String? = nil,
    lifecycleResponseOk: Bool? = nil,
    lifecycleResponseJson: String? = nil,
    lifecycleErrorCode: String? = nil,
    lifecycleErrorMessage: String? = nil,
    lifecycleErrorHint: String? = nil,
    visible: Bool? = nil,
    wasVisible: Bool? = nil,
    dismissed: Bool? = nil,
    orientation: String? = nil,
    gestureFallback: String? = nil,
    gestureFallbackMessage: String? = nil,
    gestureFallbackHint: String? = nil,
    runnerFatal: Bool? = nil,
    runnerFatalReason: String? = nil,
    completedSteps: Int? = nil,
    failedStepIndex: Int? = nil,
    sequenceResults: [SequenceStepResult]? = nil
  ) {
    self.message = message
    self.text = text
    self.found = found
    self.items = items
    self.nodes = nodes
    self.truncated = truncated
    self.snapshotQuality = snapshotQuality
    self.gestureStartUptimeMs = gestureStartUptimeMs
    self.gestureEndUptimeMs = gestureEndUptimeMs
    self.x = x
    self.y = y
    self.x2 = x2
    self.y2 = y2
    self.referenceWidth = referenceWidth
    self.referenceHeight = referenceHeight
    self.currentUptimeMs = currentUptimeMs
    self.commandId = commandId
    self.lifecycleState = lifecycleState
    self.lifecycleCommand = lifecycleCommand
    self.lifecycleResponseOk = lifecycleResponseOk
    self.lifecycleResponseJson = lifecycleResponseJson
    self.lifecycleErrorCode = lifecycleErrorCode
    self.lifecycleErrorMessage = lifecycleErrorMessage
    self.lifecycleErrorHint = lifecycleErrorHint
    self.visible = visible
    self.wasVisible = wasVisible
    self.dismissed = dismissed
    self.orientation = orientation
    self.gestureFallback = gestureFallback
    self.gestureFallbackMessage = gestureFallbackMessage
    self.gestureFallbackHint = gestureFallbackHint
    self.runnerFatal = runnerFatal
    self.runnerFatalReason = runnerFatalReason
    self.completedSteps = completedSteps
    self.failedStepIndex = failedStepIndex
    self.sequenceResults = sequenceResults
  }
}

struct ErrorPayload: Codable {
  let code: String?
  let message: String
  let hint: String?

  init(code: String? = nil, message: String, hint: String? = nil) {
    self.code = code
    self.message = message
    self.hint = hint
  }
}

struct SnapshotRect: Codable {
  let x: Double
  let y: Double
  let width: Double
  let height: Double
}

struct SnapshotNode: Codable {
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

struct SnapshotOptions {
  let interactiveOnly: Bool
  let depth: Int?
  let scope: String?
  let raw: Bool
}
