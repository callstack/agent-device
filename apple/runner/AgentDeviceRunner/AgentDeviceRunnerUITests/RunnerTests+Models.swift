import AgentDeviceSnapshotPresentation

// MARK: - Wire Models

enum CommandType: String, Codable, CaseIterable {
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
  case appState
  case activate
  case terminate
  case targetReset
  case shutdown
}

/// What the runner may do about a command whose app is not running. This is the only fact that
/// decides whether a stopped app is started, so it is declared per command rather than inferred
/// from whether the command may be replayed (#2890).
enum CommandLaunchPolicy: Equatable {
  /// Never brings an app forward: the command answers from the runner's own capture and state, or
  /// drives the runner's own lifecycle.
  case noApp
  /// Answers from the surface that already has focus, where activating an app would cancel exactly
  /// what the command is about: an in-place system surface, or a press that belongs to the system.
  /// Only iOS registers surfaces that can be served in place, and
  /// `prepareActiveCommandContext` is where that one platform exception is written.
  case presentedSurface
  /// Refuses with `APP_NOT_RUNNING` rather than starting a stopped app, because `activate()` on a
  /// not-running app is a bare launch (#2852). The refusal is about a session app, so it answers an
  /// explicitly requested bundle id on the platform that can read that app's state; a request naming
  /// no app has no session app to refuse.
  case existingApp
  /// Brings the app forward, which bare-launches it when it is not running.
  case mayLaunch
}

/// Runner command traits — see CONTEXT.md ("Runner command traits").
///
/// Single source of truth for how the runner classifies one request. Each fact names the one
/// decision that reads it, so opting a command out of a decision is a declaration about that
/// decision alone and cannot silently move another. `Command.traits` resolves them against the
/// request, so a payload-dependent fact is settled once instead of re-read per consumer.
///
/// Commands that decide alike share one named group instead of repeating a literal per fact, and a
/// group spells only the facts that reach its commands; a fact an arm answers before reading falls
/// to the initializer's default. The completeness test pins every fact on every command either way,
/// so a default that stopped matching its consumer is a red row rather than a silent one (#2890
/// review). The groups are file-private so a test of the classification has to spell the facts
/// rather than re-derive them from the same names.
///
/// The classification is load-bearing for ADR-0002 session invalidation: `retryOnSessionLoss` gates
/// the retry that nulls currentApp/currentBundleId, and `launchPolicy` — never the retry fact —
/// decides whether a stopped app is brought up.
struct CommandTraits {
  /// Whether the command needs the foreground-guard + stabilization preflight before running.
  let isInteraction: Bool
  /// Whether the command is eligible for the session-invalidating retry.
  let retryOnSessionLoss: Bool
  /// What the runner may do when the command's app is not running. The one fact with no default: no
  /// command inherits a launch answer from how it was classified for anything else.
  let launchPolicy: CommandLaunchPolicy
  /// Whether an XCTest-recorded failure during this command turns its own healthy response into a
  /// failure and invalidates the session. That conversion is the only evidence a mutation with no
  /// settle and no post-action observation ever landed, while a command that reports the runner's own
  /// state or drives its lifecycle has no user-visible mutation to prove.
  let convertsRecordedFailure: Bool

  init(
    isInteraction: Bool = false,
    retryOnSessionLoss: Bool = false,
    launchPolicy: CommandLaunchPolicy,
    convertsRecordedFailure: Bool = false
  ) {
    self.isInteraction = isInteraction
    self.retryOnSessionLoss = retryOnSessionLoss
    self.launchPolicy = launchPolicy
    self.convertsRecordedFailure = convertsRecordedFailure
  }
}

fileprivate extension CommandTraits {
  /// Element interactions: bring the session app forward, run the preflight, and owe the
  /// recorded-failure conversion for whatever the gesture did.
  static let interaction = CommandTraits(
    isInteraction: true,
    launchPolicy: .mayLaunch,
    convertsRecordedFailure: true
  )

  /// Mutations the runner performs without the element-interaction preflight. NOTE: `mouseClick`
  /// stays non-interaction for now — it is macOS-only and the foreground guard interacts with
  /// bespoke macOS activation, so classifying it needs a macOS smoke check first (tracked as a
  /// follow-up).
  static let appMutation = CommandTraits(launchPolicy: .mayLaunch, convertsRecordedFailure: true)

  /// Reads of the session app: replayable after session invalidation, and refused rather than
  /// answered by starting the app.
  static let appRead = CommandTraits(retryOnSessionLoss: true, launchPolicy: .existingApp)

  /// Selector resolution is an observation: it refuses a stopped app instead of bare-launching it,
  /// and the runner still must not replay it after session invalidation. Those are two facts about
  /// one command, which is why they are two declarations (#2890).
  static let selectorResolution = CommandTraits(
    launchPolicy: .existingApp,
    convertsRecordedFailure: true
  )

  /// Reads the runner answers from its own capture and state, so preparation never brings an app
  /// forward; a capture aimed at an app still observes that app while it executes.
  static let runnerCaptureRead = CommandTraits(retryOnSessionLoss: true, launchPolicy: .noApp)

  /// The runner's own lifecycle: no session app is brought forward, and no mutation is proven.
  static let runnerLifecycle = CommandTraits(launchPolicy: .noApp)

  /// Commands hosted by the surface that already has focus, which no activation may cancel. A
  /// hardware press belongs to the system rather than to the session app, and an alert answers from
  /// the modal where it sits; both mutate.
  static let presentedSurfaceMutation = CommandTraits(
    launchPolicy: .presentedSurface,
    convertsRecordedFailure: true
  )

  /// `alert get` changes nothing, so it is the one alert action that may be replayed.
  static let presentedSurfaceQuery = CommandTraits(
    retryOnSessionLoss: true,
    launchPolicy: .presentedSurface
  )
}

extension CommandTraits {
  /// The commands that own the remembered text-entry witness instead of invalidating it: `tap`
  /// records it (and clears it where a tap demonstrably did not land), and `type` reads the one this
  /// command relies on. Everywhere else on the prepared command path it is having a mutation to
  /// prove that makes a remembered tap stale, so clearing is derived from `convertsRecordedFailure`
  /// together with this set at that one consumer — not declared as a fifth fact, which the commands
  /// answered before that path would have carried without ever being read (#2890 review).
  static let textEntryWitnessOwners: Set<CommandType> = [.tap, .type]
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

extension Command {
  /// How the runner classifies this request. Exhaustive by construction: a new CommandType cannot
  /// compile without choosing a group, and the facts that depend on the payload are settled here
  /// rather than re-read by each consumer.
  var traits: CommandTraits {
    switch command {
    // The gesture families, each classified with what it is built from. keyboardReturn is the
    // sibling of keyboardDismiss (missing from the historical switch — drift the table now
    // prevents). .scroll is the fused frame-resolve + drag scroll and .desktopScroll the macOS
    // frame-resolve + wheel event sibling of .drag; .sequence is the fused multi-step batch.
    case .tap, .type, .longPress, .drag, .remotePress, .swipe, .scroll, .desktopScroll,
         .backInApp, .backSystem, .rotate, .appSwitcher,
         .keyboardDismiss, .keyboardReturn, .sequence, .gesture:
      return .interaction

    case .findText, .readText, .snapshot, .gestureViewport:
      return .appRead

    // appState reads the session app's XCUIApplication.state; bringing no app forward is what makes
    // its answer the state the app is in, not the one a repair leaves.
    case .screenshot, .status, .appState:
      return .runnerCaptureRead

    case .alert:
      return (action ?? "get").lowercased() == "get"
        ? .presentedSurfaceQuery
        : .presentedSurfaceMutation

    case .recordStop, .uptime, .terminate, .targetReset, .shutdown:
      return .runnerLifecycle

    case .actionButton:
      return .presentedSurfaceMutation

    case .querySelector:
      return .selectorResolution

    case .mouseClick, .home, .recordStart, .activate:
      return .appMutation
    }
  }
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

/// The display one runner screenshot came from, as the capture measured it rather than as the host
/// could guess. A runner capture can come from a different panel than the one the host resolved, so
/// density normalization has to read the scale of the image that was actually taken (#2728).
struct ScreenshotMetadataPayload: Codable {
  let displayID: UInt
  let pixelWidth: Int
  let pixelHeight: Int
  let pixelsPerPoint: Double
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
  var applicationState: String?
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
  /// Present on a screenshot the runner captured from a display it resolved, alongside the
  /// `message` path or `imageBase64` payload that carries the image itself (#2728).
  var screenshotMetadata: ScreenshotMetadataPayload?
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

/// A runner failure the session-loss retry may recover from by re-resolving the target.
enum RetryableResponseFailure: Equatable {
  case targetAppUnavailable
}

struct ErrorPayload: Codable {
  var code: String?
  let message: String
  var hint: String?
  /// Runner-internal: read by `shouldRetryResponse` and never encoded, so the host's decoding of
  /// the error is unchanged.
  var retryableFailure: RetryableResponseFailure? = nil

  private enum CodingKeys: String, CodingKey {
    case code
    case message
    case hint
  }

  static func targetAppUnavailable(bundleId: String?) -> ErrorPayload {
    let subject = bundleId.map { "app '\($0)'" } ?? "runner app"
    return ErrorPayload(
      message: "\(subject) is not available",
      retryableFailure: .targetAppUnavailable
    )
  }
}
