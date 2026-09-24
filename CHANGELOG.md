# Changelog

## Unreleased

- Changed (apple): a read-only runner command is resent inside the same request only when the
  runner refused it as `RUNNER_BUSY`. Before, any `COMMAND_FAILED` carrying `details.retriable:
  true` was sent up to three times. That flag tells a caller's own poll, such as `wait`, to try
  again. It does not mean a resend is safe inside one request. A runner startup that ran out of its
  budget (`runner_phase_budget_exhausted`) or could not read the Xcode toolchain
  (`apple_toolchain_probe_unavailable`) now fails once, not three times with a fresh startup budget
  each time. A `retriable` failure from an external Apple runner provider is also no longer resent.
  The error keeps `retriable: true`, so the caller's next request still tries again. (#2862)
- Fixed (mobile): a read taken right after a `scroll`, `swipe`, or `gesture swipe` no longer reports
  a definite miss when the surface never settled. When post-gesture stabilization ran out of budget
  on a surface still moving, `is visible` answered a plain `selector_not_found` and `is absent`
  passed. That capture now carries `unsettledGesture`: `is`, `get`, `find`, and `wait` report it (in
  `error.details` or `data`) with an appended warning, `snapshot` appends the warning, `is absent`
  refuses with `observation: "unsettled"`, `wait absent` keeps polling, and the next read captures
  afresh. Click, press, and fill by selector do not disclose it yet. A failed read now also carries
  `targetActivation` in `error.details`, the same place as `unsettledGesture`.
- Fixed (ios): `open` on a local Simulator now waits for the launched app's discovery before it
  decides whether the app is observable. On a loaded host `simctl spawn launchctl list` outlasts one
  1.5 s discovery wait slice, and the launch observation read that slice as an unobservable app, so
  the open returned before the discovery, the AX-bridge preparation or the first bridge connection.
  The first `wait` after the open then paid all three in one poll, behind a runner `findText`, and on
  CI it spent its whole 10 s budget there (`wait_capture_stalled` with `captures: 1`). The probe now
  joins the running discovery, bounded by the discovery's own deadline, and then observes the launch
  as before. A resolution failure other than a pending discovery still ends the probe at once.
- Fixed (ios): `alert accept` and `alert dismiss` no longer land their tap after the command's
  deadline when a notification banner is on screen. XCTest checks for SpringBoard banners and alerts
  before every event and its default handler waited up to 15 s for a banner to leave, so the command
  answered `ALERT_DEADLINE_EXCEEDED` ("The button was activated once") for a tap that arrived after
  the caller was told it had failed (#2546's late tap, from the banner side). Alert activation now
  opts out of XCTest's interruption handling, which also stops that handler from pressing a button of
  its own choosing on an unrelated system alert while the command answers the alert it resolved.
- Fixed (macos): `screenshot --fullscreen` on the `desktop`, `menubar`, or `frontmost-app` surface
  now refuses with `INVALID_ARGS` (`details.reason:
  SCREENSHOT_FULLSCREEN_MACOS_HELPER_SURFACE_FIXED_FRAME`) instead of being accepted and silently
  ignored. Every one of those surfaces captures through the macOS helper, which always reads the
  main display, so the flag never named a frame the capture could vary. A `.ad` script or project
  config that sets `screenshotFullscreen` for one of those surfaces now fails instead of succeeding
  with the same image it always produced; drop the flag there. macOS app sessions and every other
  platform keep accepting `--fullscreen` unchanged. (#2799)
- Fixed (ios): no runner read launches a session app that is not running anymore. The XCTest runner
  repaired foreground loss by calling `activate()`, which launches an app that is not running. After
  `open <app> --relaunch --launch-url <url>` on a Simulator, iOS can hold the launch behind an
  "Open in …?" confirmation, and the first read of the waiting session launched the app without the
  URL. Reads — `snapshot`, `wait`, `is`, `get`, a reading `find`, and an interaction's leading reads
  (the viewport read a `gesture` starts with, the capture that resolves a selector `click`/`fill`) —
  now refuse with `COMMAND_FAILED`, `details.runnerErrorCode: "APP_NOT_RUNNING"`, `retriable: true`
  and a hint to answer the prompt with `alert accept` or relaunch with `open`. A `wait` polls
  through the refusal; the runner transport never resends it. Interactions that mutate without a
  leading read (`press`, a coordinate `fill`, `swipe`, `scroll`, hardware keys) keep the foreground
  repair and still bring a stopped app up.
- Fixed (ios): a local Simulator snapshot taken through the host AX bridge once again publishes the
  geometric `hittable` fact, so `is hittable` and a `hittable:` selector resolve the same controls on
  the bridge and the XCTest runner. The snapshot capability table has declared `hittable =
  geometric-actionability` for every backend (#1933), and the runner has always stamped it; when 0.21.0
  made the AX bridge the Simulator's snapshot source, the bridge reader mapped the traits word into
  `enabled` and `selected` but handed over no hit result and disclosed `hittability` as unavailable on
  every capture, so a `hittable:` selector matched nothing on the bridge that the runner would match.
  The reader now derives `hittable` on its raw nodes from the same rule the runner's Swift uses — the
  shared `isGeometricallyActionable`, `CGRect.contains` half-open edges and all — applied to the node's
  own frame and the reported viewport, and discloses `hittability` as unavailable only when no viewport
  is reported. Because it stamps the raw source rather than the fold, `snapshot --raw` matches too, and
  the residue owner stays the fact owner (#2199). Closes the hittable-absence half of the AX-bridge
  capture divergence (#2638).
- Fixed (web): `press --double` and `press --hold` on a web session now answer with a typed reason
  instead of an unclassified `UNSUPPORTED_OPERATION` naming an interactor member. The browser owner's
  `tapPoint` cell admitted the whole press series, but the web click affordance is one immediate
  pointer press per call: `--count` repeats it, and this owner composes neither a fused double-click
  nor a timed hold. A hold is refused by the `longPressPoint` cell that already refuses `longpress`,
  so both commands now carry the hint "A web click is one immediate pointer press; the browser backend
  has no timed hold." and `press --hold` adds `details.reason: "unsupported-platform-leaf"`. A
  double-click is refused by the fused mechanic the web interactor no longer carries, reporting
  `details.reason: "owner-capability-missing"`; both refusals arrive when the press runs, after any
  target selector was resolved. A repeated single-tap press (`--count 3`) keeps working on the same
  session, and every owner that double-tapped or held before this change still does: Android, iOS,
  Linux, HarmonyOS, Cloud WebDriver and Limrun keep their own mechanics, and an owner with a fused
  point press keeps answering `--double` through it.
- Fixed (ios): a local Simulator snapshot taken through the host AX bridge once again carries the
  accessibility `selected` state, so `is selected`, a `selected=true` selector, and a Maestro
  `selected:` qualifier match the active control. When 0.21.0 made the AX bridge the Simulator's
  snapshot source, the bridge's node reader mapped the traits word into `enabled` but never into
  `selected`, so an active bottom tab, chosen segment, or checked row published no `selected` field
  and every `selected:` match failed on the iOS Simulator — a fact the 0.20.x XCTest tree had always
  supplied and that `snapshots.md` still promises. The reader now derives `selected` from the
  selected-trait bit of the same traits word, publishing `selected: true` only when set and omitting
  it otherwise so the two producers cannot be told apart by a `selected:` selector. The bit is pinned
  by the guest's real captured words, so a producer encoding change cannot drop the fact silently
  again.
- Fixed (ios): an interactive snapshot no longer drops the rows of a list whose row hosts a scroll
  view of its own. Ownership of a scroll indicator is now read from its parent edge — a visible band
  derives only when the indicator's parent is itself a scroll type — instead of walking ancestors for
  the nearest scrollable or text node. #2740 closed the class for `TextView` alone; the walk still
  misattributed the indicator of any other scroll-shaped host that publishes as a non-scroll type (a
  `WebView`, a map view, a paged cell) to the enclosing list and clipped that list to the host's
  one-line band. Ownership still passes up through ancestors that share the scroller's exact frame, so a
  `WKWebView` page — whose indicator sits under `WebView` wrappers that fill the scroll view — keeps its
  visible band; the walk stops at the first frame change, so a host smaller than its list still owns
  nothing. ADR 0026.
- Fixed (ios): `fold half-open` no longer reports a pose the hinge never held. The command accepted
  the requested category as the answer whenever its four-read budget happened to end on a
  `half-open` angle, so a hinge still sweeping from 180° toward 0° — which passes through every
  half-open angle on the way — came back as a settled Book pose. An angle inside that open interval
  proves the category and nothing else, so `half-open` now requires two consecutive readings that
  both fall inside it and agree within 0.5°; a pair straddling the 179° boundary is two poses, not
  one hinge at rest. A budget ending on an unsettled angle fails with `COMMAND_FAILED` and
  `details.reason: "fold-pose-unsettled"`, carrying `requestedPose`, `observedPose`,
  `hingeAngleDegrees` and the previous reading, and says the hinge was observed half-open and did
  not settle rather than claiming it never got there. `fold-pose-unverified` still covers a budget
  that ends on another pose. Supersedes ADR 0025's budget-end exception (#2730).
- Fixed (ios): an interactive snapshot of a list whose row holds selectable text (a `TextView`) no
  longer drops every row after that text. A UITextView is a scroll view too, and XCTest publishes
  its scroll indicator inside the text; the presentation read that indicator onto the list around
  it and clipped the list's viewport to one line, so a post thread whose root post is selectable
  text showed the root and none of its replies, while the full snapshot showed all of them. An
  indicator whose nearest scrolling ancestor is a text view now belongs to that text view and
  derives no list viewport.
- Fixed (ios): a foreground repair names the state the session app was really in. The decoder translated
  the runner's raw `XCApplicationState` integer from a handwritten table that had
  `runningBackgroundSuspended` (2) and `runningBackground` (3) the wrong way round, so a suspended app
  was disclosed as merely backgrounded in `targetActivation.priorState` and in the appended warning —
  as shipped in v0.21.7 and v0.21.8. The table now follows what the SDK declares, a runner XCTest pins
  every integer against `XCUIApplication.State` itself, and the decoder test reads those pins, so the
  two copies cannot drift apart unnoticed.
- Fixed (macos): `press` and `click` on the `frontmost-app`, `desktop`, and `menubar` surfaces post
  clicks the way a trackpad does. The helper posted the release in the same tick as the press, so
  AppKit dropped it and controls never activated; each press is now held (`--hold-ms`, 60 ms by
  default, 40 ms at least). `--count` is that many independent clicks and `--double-tap` posts each
  as a double-click pair, the helper's deadline follows the click schedule instead of a fixed 30 s,
  and every stop the host applies mid-hold — a cancelled request, a dropped client, the deadline —
  reaches the helper as SIGTERM first so it releases the button before it exits; SIGKILL only
  follows a helper that has not exited a second later.
- Added (ios): `fold <closed|half-open|open>` and `client.command.fold({ pose })` put a foldable
  iPhone simulator (iPhone Duo) into a hinge pose. ADR 0025 recorded that no official host API sets
  the pose and left it to the operator; the pose is now set the way the operator did it, by pressing
  the pose control in the Xcode Device Hub window through macOS accessibility, and it is confirmed
  the way ADR 0025 asked for, by reading the hinge angle back from CoreDevice
  (`devicectl device motion hinge-angle`) until it agrees with the request. The response reports
  the verified pose, the hinge angle, and the panel the device now lights with its native panel point
  size, so an agent can see the lit panel changed without another capture. The macOS helper
  gained a `device-hub pose` subcommand that finds Device Hub in the process table (LaunchServices
  registers the trampolined app with no pid), reopens its window when it shows none, and selects the
  simulator through the sidebar row keyed by its UDID so two simulators sharing a name cannot be
  confused. Simulator-only; a single-panel simulator refuses with `UNSUPPORTED_OPERATION`, and every
  other platform states its own refusal cell.
- Fixed (ios): the `fold` response's `screen` dimensions now match their coordinate-space contract. They
  are the lit panel's own native points (pixels divided by its point scale, never rotated), so the
  response carries the `coordinateSpace: "native-panel"` discriminator and the docs no longer claim
  they are the next snapshot's coordinates. They cannot place a tap; take a fresh snapshot for the app
  viewport.
- Added (diff): `diff screenshot` accepts a JPEG baseline or current image. Both inputs had to be PNG,
  so a capture exported by another tool had to be converted first and a HarmonyOS capture — which the
  platform serves as JPEG under whatever name the command was given — could never be compared. Each
  input is now decoded from its own bytes, so the container is sniffed and a `.png` name holding JPEG
  decodes as JPEG. `png-transcode.ts` became `screenshot-image.ts`, the one owner of that sniffing for
  both the decode and the provider transcode path, and the PNG worker gained a `decode-image` job that
  answers pixels instead of PNG bytes. The `--out` diff image stays PNG, as do the crop, overlay, and
  resize passes that rewrite a screenshot in place and could not survive a lossy container.

- Added (maestro): `setPermissions` and `launchApp.permissions` support `all: allow|deny|unset`
  on iOS simulators and Android, with specific entries overriding `all`. Both accept a
  Maestro-style permissions map. Entries apply in order until the selected platform refuses one,
  and the error then names what landed. Android's only allow level is while-in-use, so
  `location: inuse|never` apply `allow`/`deny` there; `location: always` and `photos: limited`
  stay Apple-only.
- Fixed (ios): `settings permission` no longer refuses a privacy service that `simctl privacy`
  accepts but omits from its own help text — Xcode 26 does that for `camera`, so
  `settings permission grant camera` and a Maestro `camera: allow` failed as unsupported while
  the raw command worked. Support is now `simctl privacy`'s own verdict per runtime, and a
  service it refuses fails with `UNSUPPORTED_OPERATION`. This also drops the cached
  `simctl privacy help` probe and the `privacy help` spawn before the first permission change.
  iOS `all` still does not cover notifications: current runtimes have no notifications service,
  so a targeted notifications change fails loudly and `all` leaves it unchanged.
- Added (limrun): `record start` and `record stop` on Limrun iOS and Android direct sessions. The
  runtime declared recording unavailable although the Limrun SDK exposes a server-side recorder.
  Start asks the instance to record (`--quality medium` maps to Limrun quality 5, `high` to 8);
  stop asks the instance to stop once, then downloads the served MP4 to the output path as a
  separate bounded step, so a dropped transfer is retried by the next `record stop` without a
  second remote stop. The capture is always the whole simulator or emulator screen; `--fps` and
  `--hide-touches` are refused, and a recording cannot be reattached after a daemon restart. The
  web recorder now shares the same transport-recording runtime.
- Added (ios): `action-button` presses the iPhone or iPad Action Button once, and `client.command.actionButton()`
  does the same. XCUITest exposes `XCUIDevice.press(.action)` with no hold-duration overload, so there is no
  `long-press` and no `--duration-ms`, and the slide surface on the same edge is Camera Control, which this
  command does not drive. The press is dispatched without the runner's app-activation preflight and with no
  post-action observation, so the session app keeps the state the press found; the runner asks the device for
  the button with `hasHardwareButton(.action)` and refuses with `UNSUPPORTED_OPERATION` on a model that has
  none, and Android, HarmonyOS, Vega, Linux, web, tvOS, macOS, and visionOS each state their own refusal.
  Simulators run no Shortcuts or App Intents, so what a press triggers is verifiable only on a physical
  iPhone (#2699).
- Changed (all): `home`, `app-switcher` and `action-button` are one system-button family in the
  runtime contract. An owner without a button now refuses it with the family's hint (for example
  `Android has no key event for this system button.`) rather than a per-button sentence, and a
  Limrun or WebDriver session that is no longer active refuses `action-button` with that session's
  own reason like every other cell; the command name still leads the `UNSUPPORTED_OPERATION`
  message.
- Fixed (android): `clipboard read` and `clipboard write` stop reporting success on a build whose
  clipboard service has no shell command. Android 16 (API 36) answers every `adb shell cmd clipboard …`
  with the framework default `Binder.handleShellCommand` — `No shell command implementation.` on
  stderr and exit status 0 — and the exit status was consulted first, so a read reported `text: ""`,
  a write reported "Clipboard updated", and `capabilities` advertised `clipboard` on a clipboard no
  adb call ever touched. The response is now classified per stream into one typed verdict shared by
  both legs and the capability probe: the service's own sentence on `stderr` outranks a clean exit
  (a service that never ran wrote no payload to `stdout`), while `stdout` stays payload until the call
  has failed. Such a device now refuses with `UNSUPPORTED_OPERATION` and a hint naming the substitute,
  and the exported `readAndroidClipboardWithAdb` / `writeAndroidClipboardWithAdb` helpers reject
  instead of resolving an empty string or nothing at all (#2674).
- Fixed (limrun): `screenshot` on Limrun iOS direct sessions writes a PNG. Limrun serves its capture
  as JPEG and the interactor wrote those bytes straight to the `.png` path, so every capture failed
  downstream with "Screenshot file is not a valid PNG". The bytes are now sniffed and a JPEG is
  transcoded to PNG before it is written; a PNG passes through unchanged.
- Changed (ios): `open --device-hub`, the `deviceHub` option of `client.apps.open()`, and the
  `deviceHub` config-file key are gone. The option has had no effect since 0.20.9: `open` surfaces
  the standalone Simulator app after a cold boot either way. Each form is now handled like any
  other unknown flag, option, or config key; drop it from scripts and `agent-device.json` (#2798).
- Changed (ios): a regular `snapshot --depth N` on the XCTest runner is a presentation cut over a
  full acquisition, not a bound on the walk. Acquisition publishes the frames the platform reported,
  one normalization pass turns geometry into the app's orientation space and recomputes `hittable`,
  and the visibility fold and depth cut run on that array. Presented trees are unchanged on the
  screens measured; a boundary container under `--depth N` now carries its scroll hints from its real
  children. The runner's regular-depth capability is `presentation-cut` (was `presented-frontier`),
  and every `CGRect` becomes a `SnapshotRect` through one initializer (#2661).
- Fixed (daemon): `close` now stops an active app-log stream (and audio probe / perf capture /
  recording) on an implicitly cwd-scoped session. Teardown addressed those resources by
  `session.name` (`default`) instead of the store address (`cwd:<hash>:default`), so the record
  read as missing, the `log stream` child leaked, and the next `logs start` on that device failed
  with "has not reached a confirmed terminal state" (#2647).
- Fixed (ios): Simulator AX bridge snapshots report `enabled`. The bridge requested no state
  attribute, so a disabled control — a React Native `Pressable` with `disabled`, for example — read
  as a plain button while the XCTest runner answered the same screen with `enabled: false`. The
  bridge now reads the element's accessibility traits (sent as a decimal string, since the word has
  bits past 2^53) and derives `enabled` from `UIAccessibilityTraitNotEnabled`. Source version
  `agent-device-simulator-ax-v1.6.0` rebuilds the cached bridge on first use.
- Changed (ios): a node the source declares disabled is presented `hittable: false` even when the
  capture has no hittability evidence, so on the Simulator bridge a disabled control stops counting
  as an interactive node and as a Maestro atomic-dispatch candidate. The navigation title affordance
  (a disabled title field presented as an enabled Button for the whole row) no longer carries the
  field's `hittable: false`; on the XCTest runner path that Button now counts as interactive and
  becomes a Maestro atomic-dispatch candidate where it was excluded before.
- Fixed (ios): a landscape iPhone snapshot reports the system keyboard's rects in the app's own
  orientation space. iOS hosts `UIRemoteKeyboardWindow` in the device's native portrait space, so its
  whole subtree arrived quarter-turned — a key measured 45 pt wide and 72 pt tall at `x 154` in an
  874 x 402 app, drawing a strip down the left edge where the screenshot shows a 724 x 204 band
  docked at `y 198`. Rules that read those numbers refused app content the keyboard was nowhere near
  and let a tap land on a key. The Apple runner now reads the app's interface orientation at capture
  time and publishes every rect under a turned surface host in the app's space, using the exact
  inverse of the rotation its synthesized touches already rotate through, so a reported rect and a
  performed tap cannot disagree about which pixel is which. The Simulator AX bridge reader has no
  interface orientation in its attribute set, so it refuses a capture holding a surface host reporting
  the app box quarter-turned — `Simulator AX snapshot unavailable
  (window-coordinate-space-unresolved); used XCTest for this capture, which reports captured geometry
  in the app's own orientation space.` — and the route sends that one capture to the runner instead of
  retiring the app generation, so the next capture of a healthy app still uses the bridge. One table
  proves both languages apply one rule: `contracts/fixtures/window-coordinate-space.json` (#2612).
- Changed (ios): the rotation table and the coordinate-space rule moved from the XCTest runner bundle
  into the `AgentDeviceSnapshotPresentation` package, where `swift test` replays the golden table
  without a simulator. No behaviour change.
- Added (limrun): `longpress` on Limrun iOS direct sessions. The interactor refused it as
  unsupported although the SDK exposes the HID primitives; it now holds one touch as a
  `performActions` batch of `touchDown`, `wait`, `touchUp`, defaulting to the 800 ms the Android
  and Linux interactors use when no duration is given.
- Fixed (limrun): `press --double-tap` on Limrun iOS direct sessions sends both taps in one
  `performActions` batch with an 80 ms on-device pause. The interactor issued two independent `tap`
  requests, so a network round trip sat between the taps and iOS recognized them as two slow
  single taps.
- Added (ios): `type` and `fill` work in the Apple Pay sheet on iOS Simulator instead of failing
  with `TEXT_INPUT_NOT_FOCUSED`. `com.apple.PassbookUIService` is served in place like the web
  sign-in host (#2438).
- Changed (ios): Simulator captures also probe for `com.apple.PassbookUIService`. It can keep
  running after the Apple Pay sheet closes, so a later capture in that app can report
  `system-surface-host-lingering` while the process stays alive.
- Changed (ios): the in-place system surface disclosure now names the sheet kind. The web sign-in
  sentence changed from "A system web sign-in sheet is presented over the app, so this snapshot
  shows that sheet (hosted out of the app process)." to "This snapshot shows a system web sign-in
  sheet presented over the app (hosted out of the app process), not app content". The payment host
  says "the system Apple Pay sheet" instead.
- Changed (android): a private adb server no longer absorbs a port its caller named. An adb request
  that names a server other than the one its route holds — `-P 5037` in argv, or `serverPort` in the
  call's options — is now refused with `managed-device-transport-mismatch` before anything is
  dispatched, where previously a `-P` in argv was rewritten onto the route's own port. A caller that
  asked for 5037 could read a zero exit as an answer about 5037 after the request had run on 15038.
  It reaches `createLocalAndroidAdbProvider(device, { serverPort })`,
  `runAndroidHostAdb(invocation, { serverPort })`, and the Limrun runtime dependency's adb calls. A
  request that names no server, or names the one the route already holds, runs exactly as before, and
  ambient adb is unchanged: with no private server named, the caller's argv is what runs, `-P`
  included (#2632).
- Fixed (android): a chunked `record stop` (recordings over 170 s) no longer warns that screenrecord
  stopped before record stop at the 180 s limit. Rotation always ends every earlier chunk before
  stop, so the warning now fires only when the last chunk's recorder had already exited.
- Fixed (android): a snapshot helper that could not prove it released device automation no longer
  refuses the next command on the strength of an `adb` call. The old code read the outcome of
  `am force-stop` as the fact it was supposed to measure, and on a loaded host that round trip can
  outlive its budget while the device is healthy — the shape of #2553 — so the helper process was
  already gone and the command still failed with `Android automation helper is still holding device
  automation ownership`. Ownership is read off the device now: the probe asks the device shell for
  `pidof com.callstack.agentdevice.snapshothelper` and tells it to echo a marker when nothing matched.
  A process id is `occupied`, the bare marker is `released`, and everything else is `unknown` —
  `error: closed`, `cannot connect to daemon`, `device offline`, or an adb client killed by a signal
  before it wrote anything. A release is therefore claimed only by an answer the transport cannot
  produce about itself, and no exit status is trusted: `adb shell` answers 0 for a device command that
  failed, and an adb that dies by signal leaves the executor inventing an exit code it never saw. A
  refusal requires two reads that both name the process, which keeps a helper still inside Android's
  exit path from costing a command. Scripts that match the failure reason see
  `android_snapshot_helper_runtime_occupied`, which replaces
  `android_snapshot_helper_retirement_unconfirmed`.
- Changed (android): a snapshot helper session that reaches ready settles a release the previous
  teardown could not prove. `am instrument` force-stops whatever is already instrumenting the helper
  package, so a session that reported itself ready is the only helper process the device has left,
  and the unproven release went away with the process that owed it; the next command no longer
  force-stops the session it has just started because `pidof` happens to be unreadable. A helper start
  that fails is also retried after a backoff scaled to how long it spent failing (10 s to 60 s)
  instead of on every command, which had roughly doubled command time on hosts where the helper never
  starts. And the wait for a started helper to announce itself no longer uses a fixed 10 s: it takes
  half of the helper-command budget the capture was built with, 15 s today, which is what had been
  pushing devices slower than a capture off the persistent path. On a host where the helper took 12 s
  to announce itself, the command used to answer with the one-shot transport and now answers from the
  session. The CLI's `--timeout` reaches that wait as its deadline aborting it, not as the number.

- Fixed: an iOS snapshot whose XCTest query-sweep tier cannot read the screen no longer ends the
  runner process. On a live React Native feed (Bluesky Home, images re-rendering) the AX server
  rejects each of the sweep's 19 element-type queries with `kAXErrorIllegalArgument`, and XCTest
  records every rejection as a test failure worded `Failed to resolve query: ...`. The runner muted
  the sibling `Failed to get matching snapshot: ... kAXError...` wording and not this one, and XCTest
  ends the test case as soon as the main-thread block that recorded an unmuted failure returns, so
  the runner died right after (or in the middle of) every hostile snapshot and the next command
  paid a full `xcodebuild` boot. Both wordings are now muted when they carry an AX server code; the
  timeout and `Application X is not running` variants keep recording. The sweep also no longer runs
  behind an abandoned read: every bounded main-thread dispatch that outlives its slice now counts
  as occupying the main thread (one counter, where the tree XPC and the system-modal probe used a
  second one of their own), so once the tree tier's viewport read grinds past its 1 s slice the plan
  goes straight to private AX and answers instead of queueing the sweep, the post-snapshot mark, and
  its own bookkeeping behind seconds of main-thread work. A capture that fails outright while that
  work is still grinding queues its cached-target drop behind it instead of waiting a second for it,
  and a fresh process's first capture is no longer penalized by the tree slice timeout, which had
  bypassed the warmup exemption every other penalty honors. The per-bundle penalty and
  accepted-depth memory that make later captures of the same screen cheap now survive, because the
  runner does.
- Changed (android): the snapshot helper release manifest no longer carries `installArgs`, and the
  helper installs with a fixed `adb install -r` like the IME helper. The array only ever spelled
  `install -r` plus the `-t` that #2603 retired with the `testOnly` flag, so the manifest → flag →
  option → flag round trip and its allowlist carried nothing. Older manifests that still contain
  the field parse unchanged; the field is ignored. The adb provider `install` capability now takes
  only `replace` (#2364).
- Changed (android, harmonyos): every `adb shell`, `adb exec-out`, and `hdc shell` command now goes
  through one device-shell funnel that renders each argument for the quoting its transport applies
  (#2026, #2611). The device shell re-parses the arguments it is handed, so an unquoted dynamic value
  was a command injection: Android quoted a few sites by hand and HarmonyOS quoted none. The two
  transports do not quote alike, which is why a caller names the transport (`'adb'` or `'hdc'`) rather
  than choosing quoting. `adb` escapes nothing, so a word reaches the device inside whatever quotes it
  is given. `hdc` wraps every element it forwards in double quotes, where a single quote is inert while
  `$`, a backquote, and `"` stay live: on a nova 14, `fill` text containing `$(id)` came back as the
  device's own `id` output and a `"` in the text ended its argument, so words on that transport are
  escaped instead of wrapped. Four effects are visible on a device. HarmonyOS `type` and `fill` text now
  reaches `uitest uiInput inputText` byte-identical, confirmed with a payload carrying quotes, a command
  substitution, a pipe, and a redirection. On Android an empty argument renders as `''` rather than
  vanishing from the command, so a command that read its own shift and its operand as two words no
  longer misaligns; HDC drops an empty element on the way to the device and cannot carry one, so it is
  refused with `details.reason` `hdc-empty-word-unsupported`, as is a script fragment, which could only
  arrive there as literal text. A script body handed to `sh -c` on the adb transport arrives as one
  argument. Custom adb executors and providers (SDK, MCP, and relay transports such as Limrun's) that
  pass a raw `['shell', …]` or `['exec-out', …]` argv are now refused with `INVALID_ARGS` and
  `details.reason` `unguarded-device-shell-argv`, because a command the transport is about to let the
  device parse has to be one the funnel built. Build it with `runAndroidShell` / `runAndroidExecOut`
  (a `DeviceInfo`) or `runAdbShell` / `runAdbExecOut` (an `AndroidAdbExecutor`), all exported from
  `agent-device/android-adb`, and pass each dynamic value as its own word. SDK: `AndroidAdbExecutor`
  and `AndroidAdbProvider.exec` now receive `readonly string[]`, so a custom executor annotated
  `(args: string[])` must widen its parameter to take the command.
- Fixed: BrowserStack sessions honour `--provider-project`, `--provider-build`, and
  `--provider-session-name`. The capability builder emitted the legacy JSON Wire keys `device`,
  `os_version`, and `app` at the top level next to the W3C `bstack:options` block; the hub treats a
  request carrying any legacy key as a legacy session, reads the labels from the legacy top-level
  `project`/`build`/`name` (never set), and ignores `bstack:options`, so every session landed in
  "Untitled Project" / "Untitled Build" with an empty name — even after #2495 carried the flags to
  the provider (#2494). The builder now emits `appium:deviceName`, `appium:platformVersion`, and
  `appium:app` and no legacy key, verified against live App Automate sessions.
- Added: `--provider-appium-version <version>` (alias `--appium-version`) pins the Appium server
  BrowserStack runs for the session, as `bstack:options.appiumVersion`. Unset, BrowserStack falls
  back to Appium 1.x, which predates the `mobile:` commands the interactor issues (`deepLink`,
  `pressButton`, `activateApp`).
- Changed (iOS runner): what recovers a stuck runner is decided by the recorded error, not by its
  wording. A readiness preflight marks the error it gives up with, and that marker is now the whole
  test for restarting the session and replaying the command — except for a request that was canceled,
  which that same catch also marks: a command nobody is going to send again has no restart to spend,
  and the session it would tear down may be one that still works. Two message checks decided it before,
  and a preflight reaches the caller in whatever shape its connect loop ended with — "Runner did not
  accept connection", "Runner endpoint probe failed", a killed `simctl` fallback, a post that ran out
  of its budget — so only some of those restarted and the rest failed the command. The other half is
  what no longer happens: when a slow
  boot spends the whole prepare budget, the health check reports "prepare ios-runner timed out", and
  that no longer wipes a restored `xcodebuild` artifact on the way to a rebuild — the runner session
  is invalidated and prepare retries with the artifact intact. Only a failure that indicts the
  artifact rebuilds it, so a runner that refuses the connection or never answers on any route still
  wipes it and rebuilds, which is what that rule is for.
- Added (record): `record stop` now answers the question a video cannot — whether its recorder
  actually stopped — beside the export. The result carries `recorder` and `nativePathDisposition` on
  CLI `--json`, the Node client, and MCP (ADR 0024). Today a stop says `confirmed`, or `lost` with
  `owner-session-lost` for an Apple recording whose session was invalidated, and names its artifact
  path `retirable` or `retired`; the wider vocabulary those two fields declare (`unconfirmed`, the
  identity-mismatch reasons, `pending`) arrives with the later ADR 0024 steps that gain the probes
  those states describe. Both are disclosures about the recorder and the path it writes to, not
  failures: the export is served either way, and a stop with nothing to report — an older session's
  replay, or a backend whose recorder writes the served file itself — omits them. No stop changes
  outcome in this release; the fields land first so the coordinator can report what it already knows
  before it starts acting on it.
- Fixed (record): an Android stop credits the device with retiring its recording only when the
  device proved the chunks gone. The probe read any failed `test -e` as "not there", so an adb that
  timed out or a device dropped mid-call turned chunks that were still on the device into
  `nativePathDisposition: "retired"`, and a reattach that could not question the device at all
  declared the recording's artifact lost. A probe that never ran now answers uncertain: the path
  stays `retirable` and the recording stays finishable until the device answers.
- Changed (record): an iOS Simulator recording no longer has the recorder write the file the caller
  asked for. `simctl` records to a `<name>.native.<ext>` sibling; `record stop` copies that file to a
  `<name>.collected.<ext>` sibling, checks that the copy has an MP4 container, writes the caller's
  `--out` path once from the copy, checks that export is a playable video, and retires the recorder's
  own file (ADR 0024 2.3). An export the finalizer refuses is removed, so `--out` only ever holds a
  video that passed that check. The
  caller's path is never a file a recorder is still writing, and a stop that fails before the export
  exists leaves it absent with the copy in place — so the next stop resumes from the copy instead of
  signalling a recorder that already stopped. Both siblings are deleted on success, and a stop that
  got that far answers `nativePathDisposition: retired` rather than the `retirable` it had to answer
  while the recorder's file and the served file were one file. A recording whose stop fails and is
  then abandoned (session close, daemon restart, forced cleanup) keeps its video in these siblings
  beside `--out`, where the recorder used to leave it at `--out` itself; they are the only copy of that
  video, so nothing deletes them.
- Changed (record): an Android recording is no longer pulled onto the path the caller asked for.
  `record stop` pulls the device's chunks to `<name>.collected.<ext>` siblings, retrying each pull
  until it plays, then writes the caller's paths from copies of them and drops the collected set once the
  finalization is journaled (ADR 0024 2.3). Chunk paths the finalizer refused are removed. A stop that dies before the export exists leaves it absent with the pulled set in
  place, and the next stop resumes from that set instead of signalling a `screenrecord` process that
  already stopped and pulling a file that may have moved since. The 180s platform-limit disclosure now
  travels with the recorder's own observation rather than with the export, so a stop that has to be
  driven again still says it; every disclosure is still in the one `warning`. A retried stop serves
  every chunk and the `capturedDurationMs` its first attempt finalized, and measures the idle tail
  against the instant that attempt signalled the recorder rather than the time of the retry. A stop
  that fails and is then abandoned keeps the pulled set on the host beside `--out`. Chunk paths and
  `--client-output-path` naming are unchanged.
- Fixed: a process lock that could not be given back no longer waits for the daemon to restart. A
  release that cannot verify ownership — a refused `unlink`, an unreadable record — left its record
  standing and naming the live daemon, and the next acquire read that as a live owner and timed out
  after 30 s on every runner build or launch until the process restarted. The claim inside is spent
  the moment the release is asked for, so a reclaim here now reads it as dead and takes the path
  back, and the failed release is recorded in the request log as `process_lock_release_unverified`.
  A record is only read that way when this loading of the lock code issued it: a second bundled copy
  of the module in the same process shares the pid and cannot have a live claim cleared under it.
- Changed (lock errors): code that takes a process lock now answers one question in one helper, which
  of its two failures the caller hears. The work inside the lock outranks a lock that could not be
  handed back, so a build or a publish that failed keeps its own error instead of being replaced by
  `Timed out waiting for …`, and work that succeeded still reports the lock it could not give back.
  The Apple runner's artifact, cache, lease and disposal paths, the managed-allocation store, the
  device-claim store, the iOS snapshot bridge cache, the Swift recording cache and the agent-browser setup
  moved onto it, replacing hand-written try/catch pairs that each chose differently.
- Fixed: the redirect of `~/Library/Developer/XCTestDevices` gives itself back in one order — restore
  the host's own device set, then release the lock — and a restore that was refused is what the caller
  is told, whichever give-back door a teardown used. The lock's own complaint used to replace it in a
  `finally` and the best-effort door then dropped it, leaving the symlink pointed at the agent-device
  simulator set with nothing said about why. A simulator whose set already is `XCTestDevices` is no
  longer failed by a lock it could not verify, either. A leftover from an interrupted build — the host's
  set renamed aside and `XCTestDevices` symlinked into a simulator's own set — is now put back before the
  redirect decides whether it is needed, so the first build after an interruption still gets its own
  device set instead of the host's. A redirect that could not be installed reports the restore that failed
  with it, and names a backup path only when that backup is really on disk.
- Changed (sessions): the implicit session is now keyed by workspace **and platform**, so one checkout

  can drive iOS and Android without inventing a `--session` name for every command (#2580). An
  implicit session was addressed by `cwd:<workspace>:default`, one slot per checkout, and it stayed
  bound to the first device it touched. A repo that tests both platforms — a visual-regression run
  across `react-native-paper` components, for example — could not open the second one at all: after
  `open --platform ios`, `open --platform android` from the same directory failed with `INVALID_ARGS`
  ("already bound to apple device \"iPhone 17\""), and so did `boot --platform android`, which binds
  nothing and only needed a device to start. The hint was correct (`--session android` works), but
  following it means threading a hand-written name through every command of both legs, and a script
  that drops one flag silently talks to the other platform's device. `--platform` now selects the
  implicit session, so the platform a script already declares is the only handle it needs:
  `cwd:<workspace>:ios` and `cwd:<workspace>:android` coexist, each with its own device, app, and
  artifact directory. Three rules keep the behavior that was already earned.
  1. A platform-naming request joins the workspace's session only when it genuinely agrees with it,
     so a session opened without `--platform` — which keeps the platform-less `default` leaf — stays
     reachable from commands that do name a platform and keeps writing to its own artifact directory
     instead of growing a twin beside it. A request that agrees on platform but names a different
     device or target still gets the existing `INVALID_ARGS` refusal; it does not silently fork a
     second same-platform session that one `--platform` would then have to disambiguate.
  2. A request naming no platform joins the workspace's only implicit session — what every
     single-platform script does today, so those are unaffected — and refuses with `AMBIGUOUS_MATCH`
     when the workspace holds several, naming every address and the `--platform`/`--session` flag
     that selects it, instead of choosing a platform by open order. Same for a broad selector such as
     `--platform apple` that matches both this workspace's iPhone and its Mac.
  3. Inventory commands — `session list`, `devices`, `doctor`, `capabilities`, `apps`, which the
     registry classifies as `sessionKind: 'inventory'` — never claim a session and keep resolving an
     address through the ambiguity. Refusing those would refuse the command an agent runs to resolve
     it. `events` and `close` are deliberately not in that set: each reads or tears down one session,
     and a silently-empty `events` or a `close` that closed nothing would be worse than the refusal.
  Two adjacent repairs were required. A settling interaction published the live session under
  `SessionState.name`, which for an implicit session is only `default` and not the address it answers
  to, so `agent-device session list` already reported a phantom second row beside the real session;
  under platform keying that phantom would also have read as a second session the caller has to
  disambiguate, so the publisher now stores under the key the store itself owns, and workspace-session
  counting collapses one session reachable under two addresses regardless of writer. And
  `--session-lock`'s platform reaches `flags` only after routing has chosen the key, so routing now reads `meta.lockPlatform` too — otherwise a
  lock-policy caller, the exact audience that avoids naming sessions, would land on the wrong leaf.
  Explicit `--session <name>` is untouched and still addresses one session verbatim.

- Fixed: a `record stop` that could not produce its export no longer destroys what its own retry reads
  back (#2591). The shared coordinator compensated every failed finish by force-cleaning the resource,
  which on Android deleted the device-side MP4 and the native manifest the hint just told you to re-pull:
  the second `record stop` had nothing left to collect and the recording was gone. Each durable kind now
  declares what its retry needs. `screen-recording` and `perf-capture` preserve, so a failed stop keeps
  the device artifact, keeps the manifest `open`, returns its own error, and the next `record stop` in
  that session exports it — proven on an emulator whose `adb pull` failed its first attempts and then
  exported the 90 KB the first stop left on the device. `app-log` and `audio-probe` say
  `dispose-on-failed-finish` themselves, because their retries re-read a log file and a status file that
  cleanup never touches. A finish also states why it was asked for: `capture` may preserve, while
  `disposal` — session teardown, the one caller that owns forced cleanup — disposes whatever a failed
  finish left. Two Apple paths had to become genuinely retryable for that to be true: the runner path
  memoized its refused stop and handed the same rejection to every later `record stop` without asking
  the runner again, and the simulator path rejected a recording purely because `simctl recordVideo` had
  exited non-zero — discarding a video the recorder had already written and leaving an exit code no
  retry could change. A stopped recorder is now an observation rather than a failure: the exit is
  disclosed on the completion and the file is collected, so those recordings export instead of erroring.
  Expect one trade: while a preserved recording is open, `record start` on that device is refused until
  its session runs `record stop` or closes. A simulator recording no retry can rescue now names the
  exit that made it unreadable — `simctl recordVideo exited with code 1`, `was killed by SIGKILL`, plus
  the recorder's stderr — drops its retriable flag, and points at closing the session, while a recorder
  still finalizing its file keeps the retry hint. `perf stop` no longer memoizes a refused finish, so its
  second attempt re-pulls the trace the first one preserved.

- Changed: `record stop` no longer carries a start-trim step no recorder could arm. The trim cut the
  interval between recorder start and target-app readiness, but the runner's `recordStart` answer has
  never carried either timing and the simulator path supplies none, so every built-in recording took
  the untrimmed branch while the packaged Swift trimmer, its contract fields, and the telemetry
  timestamp shifting stayed shipped with it. Gesture telemetry now carries the timestamps it recorded;
  recorded videos are byte-for-byte the videos those paths already produced. Overlay burn-in, output
  stability checks, and the recorder-start gesture-clock anchor are unchanged (#2584).

- Fixed: an iOS capture that no backend could read now says which backend was asked and what was on
  screen, instead of failing on the internal `regular iOS snapshot presentation requires a valid
  viewport` invariant alone (#2560). The runner declares such a payload sparse — backend, reason code,
  and its own reason — and the daemon read that verdict, then discarded it while reconstructing a
  viewport from a synthetic root that has none. A `snapshot --actions` capture of a web sign-in sheet
  therefore reported a viewport problem and named neither the private-AX backend that cannot read an
  out-of-process surface nor the surface presented over the app. The verdict now travels with the
  refusal as `error.details.snapshotQuality`, and the hint composes the shared sparse-capture advice
  with the bundle id of the surface host when one is presented. On `replay` and `test` the verdict now
  survives into the `REPLAY_DIVERGENCE` details, which carried only four cause keys before. Captures
  that used to succeed are untouched: a sparse payload whose tree presentation can still serve presents
  exactly as before, and a payload the runner did not declare sparse keeps the plain invariant byte for
  byte.

- Fixed: skipped `optional: true` Maestro steps are no longer invisible on the human surface
  (#2560). The warning a skip leaves now travels with the run whether it later passes or fails:
  `replay` prints a `Warning:` line after its summary and repeats the run's warnings after a
  failed run's error, `test` prints a `Warnings:` section after the suite summary naming each
  test, and a failed test result gained the `warnings` array the passing result already had, so
  `--json` and JUnit carry the skipped steps of a failing test too.
- Fixed: an Apple runner presentation refusal now carries the registry identity of the system
  surface the tree was acquired from as `error.details.systemSurface` (#2560). Previously a
  selector-backed command failing at the capture boundary under `optional: true` gave nothing
  naming that boundary — the web sign-in sheet out of `SafariViewService` was invisible in the
  error, and the miss looked like a selector problem inside the app. The sparse-declared case
  already names the surface host in its hint via #2572; this covers the provenance everywhere
  the runner reports one.
- Changed: a capture that a backend cut at one of its limits now says so in the snapshot's
  warnings, on every platform, instead of only setting `truncated: true` in JSON. The text path
  had no disclosure at all, so an agent read a screen missing its footer, tab bar, or the items
  after a long list as complete — the backends walk the tree in document order, so what falls
  off is what comes last, on screen or not. One shared warning renders from the shared flag; the
  limit and dimension stay backend-side. The depth-cap warning no longer suggests `--scope` as a
  way to read deeper: on iOS, scope narrows the presented view and acquisition stays scope-blind.
- Changed: the iOS Simulator AX bridge caps a capture at 5000 nodes, up from 1500, the Android
  helper's bound. Measured on a synthetic 600-row screen, acquisition time did not move with the
  cap (the native read fetches the whole tree; the cap only stops conversion) while the 1500 cut
  dropped the screen's on-screen footer.
- Fixed: Android snapshots carry the accessibility `selected` state an app sets on a control, so
  `is selected`, a `selected=true` selector, and a Maestro `selected:` qualifier work on Android
  (#2462). The helper never serialized the attribute, and the host reads only the helper's XML, so
  no later layer could recover it: `get attrs` had no `selected` field, no snapshot
  node was marked selected, and the same assertion that passed on iOS failed on Android with
  "Maestro visible condition did not match" for an element that is visible — while `selected: false`
  matched every Android node. The helper now emits both answers, like `enabled` and `password`, so
  an unselected control answers `false` and a helper older than the attribute answers nothing; the
  host parser, the Android hierarchy node, and the published snapshot node carry it through to
  `get attrs` and the `[selected]` marker in snapshot text. Snapshot lines now render that marker
  whenever selection is rendered, not only when text surfaces are summarized: `--settle` and `diff`
  already compared selection, and a line that compares a fact it cannot display turns a tab tap
  into a changed pair whose two lines look identical.
- Fixed: Replay test artifacts with colliding filenames retain distinct copies without overwriting
  other diagnostics, replay sources, timing traces, or attempt manifests.
- Fixed: Custom test reporters reject invalid exit codes, including values such as `256` that
  could wrap to success and hide a failing suite. `getExitCode` accepts integers from `0` to `255`
  or `undefined`; JSON output reports an invalid code as one `INVALID_ARGS` error.
- Fixed: Android `record start` no longer refuses to begin after a reused emulator reassigned the
  previous recorder's pid. A completed recording's native marker is retired only once its recorder is
  proven gone, but only an absent pid counted as proof — a pid that now names an unrelated process,
  or a recorder that exited and waits to be reaped, did not. `record start` then failed every later
  attempt with `Android screenrecord completed evidence cannot be safely retired`, and `record stop`
  could not return an already-finalized recording. Proven termination now retires the marker and
  returns the stored completion; a live or unreadable recorder still blocks, and the unrelated
  process is never signalled. A reused pid that runs a replacement `screenrecord` on the same
  remote path proves the old recorder gone but not that the path is free, so that marker and
  artifact are retained until the replacement ends, and neither is signalled (#2476).
- Fixed: Android `record start` no longer refuses forever on an emulator re-adopted under a new
  serial. The device-side marker records the device identity that wrote it and a later start retired it
  only when that identity matched, so a marker left by an earlier session on the same AVD blocked every
  recording on the re-adopted device with `Android screenrecord native recovery evidence already exists`
  — reported as an internal error whose hint asked for a bug report — while `record stop` answered that
  no recording was active and no session could reach the marker, because recovery always binds the
  device identity its own record names. A marker now retires when its recording is terminal or when it
  names a device identity this transport can no longer address, and only once every recorder it names
  has provably released its artifact; an interrupted launch commits no recorder identity, so its
  artifact is checked against the recorders running on the device first. A recorder that is still
  writing is left alone: `record start` refuses with `DEVICE_IN_USE` and `details.writer` naming whether
  the marker's own recorder or another one holds the path, and only the unmanaged one ends on its own at
  Android's 180 second limit. A device that cannot answer that question — an unreadable process table,
  or a candidate process whose identity cannot be read — is refused rather than assumed free, even when
  other recorders writing that path were identified, so an artifact is never removed under a recorder
  the probe failed to see. What still refuses — unreadable or undecodable evidence, a marker the other
  transport mode wrote, and an open recording this device identity still owns — is now a typed error
  naming the marker path and the command that clears it, `record stop --session <name>` or removing the
  marker once no session owns it, instead of `UNKNOWN` (#2550).
- Fixed: a polling `wait` no longer surrenders its whole budget the first time the iOS runner
  answers `RUNNER_BUSY`. That code means an earlier command exceeded the runner's execution
  watchdog and its abandoned main-thread work is still draining, which clears on its own, so a
  `wait text ... 20000` could fail in under a second with a failure the runner itself asked the
  caller to retry. A poll refused with a failure its producer marked retriable is now ridden out
  like an unreadable capture: the wait keeps polling to its deadline, records the poll as
  `retriable` in its timeout evidence, and surfaces the refusal only if no readable capture ever
  completed. That surfaced refusal keeps the producer's code, message and retry details and now
  also carries the wait's own `captures`, `readableCaptures`, `waitedMs` and `polls`, so a budget
  spent entirely on refusals is distinguishable from one immediate refusal. A wedged runner
  (`RUNNER_WEDGED`) is not retriable and still ends the wait at once.
- Fixed: a runner failure recovered from the lifecycle journal after its transport response was
  lost is now classified exactly like the same failure on a live response. `RUNNER_BUSY` reached
  callers as a bare `RUNNER_BUSY` wire code without the `retriable` flag on that path, while the
  live path published it as `COMMAND_FAILED` with `details.runnerErrorCode` and `retriable: true`;
  both paths now read the runner's code through one classifier.
- Fixed: iOS Simulator snapshots of Safari and of apps with a `WKWebView` stopped showing the
  page in 0.21.0 — chrome plus empty `[webview]` nodes, no links, text, or form fields, so no ref
  could reach the page (#2484). The host AX bridge that 0.21.0 made the Simulator's snapshot source
  reads one process, and WebKit content lives in another; the bridge delivered the boundary as
  an `AXRemoteElement` leaf and the tree was published as if that were the screen. The source now
  refuses a tree whose on-screen web view ends at that leaf (`remote-content-boundary`) and the
  route serves XCTest, which resolves remote elements, for the rest of that app generation — the
  same path 0.20.x used. The snapshot discloses the switch through its warning, and a relaunch
  re-enables the bridge.
- Fixed: `test` expands relative globs from the caller's literal working directory, so directory
  names containing glob characters no longer cause missing suites or select a different directory.
  Missing non-glob inputs also retain their not-found error in these directories.
- Fixed: JUnit reports remain readable when replay results contain characters forbidden by XML 1.0,
  replacing them with U+FFFD while preserving legal Unicode and whitespace. Original suite values
  remain available in JSON and other reporters.
- Fixed: `replay export` preserves deep links without `//`, including `tel:` and `mailto:`, as
  Maestro `openLink` commands in both standalone and app-plus-link `open` actions.
- Changed: a command whose synopsis is generated names each option with the label its declaration
  carries, so `snapshot` now shows `--depth, -d <depth>` and `--scope, -s <scope>` where it used to
  show the short aliases, and `--record` is documented under `Command flags:` instead of inside the
  `snapshot` and `is` synopsis lines. `snapshot`, `proxy`, `daemon`, `device`, `doctor`, `prepare`
  and `tv-remote` no longer restate their option list in a hand-written usage string, so adding an
  option to those commands updates `--help` on its own (#2444).
- Fixed: iOS `--depth` on `snapshot`, `is`, `wait`, `get`, and `find` no longer fails with
  `regular iOS snapshot presentation requires a valid viewport` when the runner plan is pinned or
  deferred to the private AX backend (custom actions, a private AX verdict on the session, or the
  XCTest channel penalty). The runner refused a regular depth-capped request on every backend but
  the recursive tree, fell through to its synthetic sparse root, and the daemon rejected that root
  as a missing viewport. Presentation applies the presented-depth cut to whatever hierarchy a
  backend acquired, so every backend serves the request; the private AX declaration is now
  `regular-depth=presentation-cut` and an acquisition that stopped short of the cut keeps
  disclosing that through `truncated`/`effectiveDepth` as it does unscoped.
- Fixed: repeated unfiltered Android snapshots stay compact when identical element bounds arrive
  with a different property order. Changes to the bounds still re-emit the tree.
- Fixed: iOS `network dump` no longer omits requests that reused a keep-alive connection.
  CFNetwork logs a request URL only on the line that opens a connection, so a second request to
  the same host produced no `url:` line and was dropped from the dump entirely — an "this endpoint
  was called" check read as a definite fail. Such a request is now reported against the origin its
  connection was opened for, with `pathUnavailable` set, its status, and its timing. A reused
  request whose connection was opened before the scanned window cannot be named at all; those are
  counted in the dump's `unnamedRequests`, so an empty result still reports that traffic was
  observed. The identities behind that count reconcile the app-log and recovery windows internally
  — so overlapping traffic is not double-counted and disjoint traffic is not under-reported — but
  the response carries only the count, which stays bounded however large the scan window was. The notes say absence of an endpoint does not prove it was not called.
- Fixed: a URL logged as a delimited `url: <value>,` field no longer keeps the separator the log
  format put after it, so an entry's `url` compares equal to the endpoint under test. A bare URL
  elsewhere is left alone, since nothing there establishes that trailing punctuation is not part of
  the path.
- Added: `replay export` supports flows that switch apps and return, preserving each
  `open <appId>` target as an explicit Maestro `launchApp.appId`.
- Added: `replay export` converts recorded `home` actions to Maestro `pressKey: Home`, allowing
  app-to-home-to-app journeys to be exported.
- Added: polling `wait` timeouts (`wait <selector>`, `wait text`, `wait @ref`, and `wait absent`
  after a readable capture) carry a per-poll timeline in `error.details` (`captures`, `polls[]`
  with `startedMs`, `durationMs`, and a typed `outcome`: readable, unreadable, deadline,
  runner-restart) next to the unchanged `reason`, so a failure says where its budget went without
  opening the request log. Long waits keep the first five and last twenty-five polls. The replay
  landmark-mismatch refusal carries the same poll evidence next to its mismatch details; `wait
  --stable` timeouts and a never-readable strict absence keep their existing diagnostics.
- Fixed: Android `orientation` now returns once the display reports the requested rotation
  (polling `dumpsys display`, up to 15s) instead of right after writing the settings. On a loaded
  emulator the rotation takes seconds, during which accessibility reads hang, so the next command
  paid for the transition; a `wait` issued right after `orientation` could spend its whole budget
  there. A display that never reaches the requested rotation now fails the command with the
  observed rotation instead of reporting success; a display that reports no rotation is left to
  the setting as before.
- Fixed: the iOS Simulator AX snapshot route bounds how long a capture waits for app discovery
  and stops starting a discovery per capture. Discovery (`simctl launchctl list` through xcrun)
  takes seconds on a loaded host; a capture now waits at most 1.5s for the one in-flight
  discovery, takes the XCTest fallback, and the discovery keeps running under its own 15s
  deadline for the captures that follow. Previously each capture ran its own probe with a 3s
  timeout on its critical path, so a `wait` issued right after `open` could spend its budget on
  probe timeouts and report `wait_capture_stalled` with the app already on screen.
- Fixed: iOS snapshots no longer report `truncated: true` merely because a later backend produced
  them. The runner stamped every recovered capture as truncated — including a complete private-AX
  tree taken while the XCTest channel was penalized as slow — so a strict `is absent` / `wait absent`
  refused it with "capture was truncated" on loaded CI hosts. `truncated` now tracks completeness
  only: payload truncation, a depth-limited capture, or a sparse terminal payload.
- Fixed: Android `alert accept` / `alert dismiss` return only once the dialog has left the
  accessibility tree (a different alert taking its place counts as dismissed), matching the iOS
  runner's re-check. Previously they returned right after the button press, so the next read could
  still see only the dialog window. A dialog that stays visible past the action budget now fails with
  `alert <action> did not dismiss the visible alert`.
- Added strict `wait absent <selector> [timeoutMs]` polling for zero selector matches. Incomplete,
  sparse, truncated, scoped, depth-limited, and Android unreadable captures cannot prove absence;
  deadline diagnostics retain typed capture evidence and stable first-match details (#2236).
- Added: the device-claim store can hold an allocator-held claim (schema v3) for a device an
  allocator-managed pool owns. It has no owning process, so `device status` lists it in the normal
  view (never as stale), `device release --stale` refuses it with `allocator-held-owner`, the
  daemon-startup sweep and session close leave it alone, and a command that binds the device
  ordinarily is refused `DEVICE_IN_USE` / `DEVICE_CLAIM_ALLOCATOR_HELD`. Process-owned claim files
  are unchanged at schema v2. Two notes for mixed installations: a daemon older than this release
  reads a v3 file as an unreadable claim record and fails closed rather than clearing it, and
  `devices` reports no `claimedBy` for such a device until the managed-inventory filter lands.
- Added the `harmonyos-instance` lease contract and CLI/runtime plumbing as a prerequisite for
  HarmonyOS proxy support; provider/daemon allocation remains gated until its end-to-end lifecycle
  is implemented and validated (#2266).

- Fixed: `settings airplane on|off` now takes an Android device offline. It is applied through
  the connectivity service (`cmd connectivity airplane-mode`), which drives the radios, instead of
  writing `airplane_mode_on` and broadcasting `ACTION_AIRPLANE_MODE_CHANGED` — a broadcast Android
  refuses for non-system callers, so the old path failed *after* writing the setting and left the
  device reporting airplane mode with the network still up (#2223). The response now reports the
   `airplaneMode` the connectivity service holds after the change, and an Android build that does not
   expose that command is refused with `UNSUPPORTED_OPERATION` before anything is written.
- Fixed: the MCP registry entry (`server.json`) now declares the fixed `mcp` subcommand via
  `packageArguments`, so a registry-format launcher — the MCP Registry or the website's
  `/.well-known/mcp.json` discovery manifest — starts the stdio MCP server. Previously it ran
  `agent-device` with no subcommand, i.e. the bare CLI (#2275).
- Breaking (0.21): iOS Appium/WebDriver snapshots now expose engine-owned acquisition facts and
  typed fidelity warnings. The SDK snapshot `truncated` field is optional when Appium cannot report
  hierarchy completeness; regular snapshots fail closed without valid viewport evidence, while
  `snapshot --raw` remains available for diagnostics (#2195).
- Security (daemon, remote/proxy HTTP only): when `AGENT_DEVICE_HTTP_AUTH_HOOK` is configured and a
  request's hook result does not attest a `tenantId`, the request is now refused (401) outright — the
  daemon no longer runs it as whichever tenant the client declared (RPC body `meta.tenantId` or
  `flags.tenant`, or the `x-agent-device-tenant` header on the upload/artifact-download/diagnostics
  routes) and no longer admits it unscoped when the client declares nothing either. This closes both
  a shared-token impersonation path and an unscoped-access path to tenant-owned sessions/artifacts in
  multi-tenant deployments. Deployments with no hook configured (the local loopback CLI) are
  unaffected. A hook must attest `tenantId` on every request it wants the daemon to admit.
- Breaking (0.21): removed aggregate performance compatibility (`perf`, `perf sample`, `perf metrics`, the `metrics` alias, optionless `client.observability.perf()`, and SDK `area: 'metrics'`). Use `perf frames`, `perf memory sample`, `perf cpu profile start|stop|report`, or `perf trace start|stop`; removed CLI and raw daemon forms fail with this migration guidance.
- Breaking (0.21): removed legacy batch JSON steps with `positionals`/`flags`. Use `{"command":"...","input":{...}}`; rejected steps now include a concrete structured example.
- Breaking (0.21): removed the deprecated Node client `command.rotate` wrapper and its `RotateCommandOptions` / `RotateCommandResult` exports. Use `command.orientation`; the already-removed CLI `rotate` form keeps its targeted migration error.
- Security (MCP/AI-SDK tool surface): the operator-owned endpoint and path inputs — `daemonBaseUrl`,
  the Metro `proxyBaseUrl`, `stateDir`, `cwd`, `iosSimulatorDeviceSet`, `iosXctestrunFile`,
  `iosXctestDerivedDataPath`, `iosXctestEnvDir` — follow the credential inputs off the
  model-writable tool surface: no longer advertised, refused as explicit input with guidance, and
  resolved from env/config only (a model-writable `daemonBaseUrl`/`proxyBaseUrl` would redirect the
  env-resolved token to an arbitrary server). Dropping these plus the credential fields shrinks
  `tools/list` by roughly half. CLI flags and the SDK client options are unchanged.
- MCP tool descriptions now declare their enforced client timeout envelope (90s default, 180s
  install, 300s+ lease allocation, unbounded only for the streaming `test` runner), sourced from
  the descriptor registry's timeout policy so the declared number cannot drift from the enforced
  one.
- Security (MCP/AI-SDK tool surface): the shared command-tool executor now enforces the advertised
  tool schema as an admission boundary — every raw `tools/call` argument must appear in the tool's
  advertised (`additionalProperties: false`) schema, or it is refused before config/env resolution.
  Hiding a key from `tools/list` alone was insufficient: the router forwards raw arguments verbatim
  and the MCP config resolver read `config`/`remoteConfig` as CLI flags, so a model-supplied config
  file could load `daemonBaseUrl`/`daemonAuthToken` and redirect the operator's token to an
  arbitrary endpoint. Deny-by-default closes that, the operator keys, and any unknown key at once;
  operator env/config defaults still resolve (they never arrive as tool input). Retired keys are
  still admitted so their migration guidance answers.
- Security (MCP/AI-SDK tool surface): `daemonAuthToken` and the Metro `bearerToken` are no longer
  advertised as tool input properties, and an explicit value is refused with guidance instead of
  being forwarded. Credentials are operator-owned: set `AGENT_DEVICE_DAEMON_AUTH_TOKEN` (or
  `daemonAuthToken` in `~/.agent-device/config.json`) and `AGENT_DEVICE_METRO_BEARER_TOKEN` on the
  process serving the tools. The model both reads untrusted app UI text and picks tool arguments,
  so a model-writable credential parameter was a prompt-injection exfiltration path. CLI flags
  (`--daemon-auth-token`, `--bearer-token`) and env/config resolution are unchanged.
- Release hygiene: after `npm publish`, `release:mark-dev` moves `main` to the next patch with a
  `-dev` prerelease marker so the version on `main` never equals a published version (registry
  scanners diff the tool surface per version string, and a moving surface under a released number
  reads as a republish). `release:prepare` refuses to publish while the `-dev` marker is in place.
- Windows `--platform web` works again. `agent-device web setup` no longer fails with
  `npm not found in PATH`, and every web command — including `web doctor` — no longer fails with
  `spawn EINVAL`. The managed `agent-browser` backend is now launched as `node <js-entry>` on every
  platform instead of through its `node_modules/.bin` console shim, which is a `.cmd` file on
  Windows that `child_process.spawn` refuses without a shell (CVE-2024-27980 hardening);
  `shell: true` would only trade that for argument-quoting hazards and a `DEP0190` warning on every
  command. Setup spawns `npm` from PATH unchanged on macOS and Linux, and runs npm's own
  `npm-cli.js` under the current Node only on Windows, where a bare `npm` is not spawnable. A
  managed install now counts as present only when the backend package itself is, and
  `web setup --json` / `web doctor --json` gain `entryScript` and `packageDir`; the published
  `binaryPath` is unchanged and still names npm's console shim, now informational rather than the
  spawned command (#2022).
- Parameterized `fill --record-as` protection is now recording-session-scoped instead of
  fill-step-scoped (ADR 0017 amendment): a later, unrelated recorded action (`wait`, `is`, `get`) can no
  longer re-serialize an app-rendered echo of an already-parameterized value into its own result or
  `target-v1` identity evidence. An echoing `wait` landmark no longer qualifies as an ADR 0016
  destination guard, so `session save-script` refuses it and directs the author to a stable landmark
  instead of silently publishing the secret. The protection uses one small, explicit, ephemeral,
  never-serialized per-session map populated only from values the author already opted to parameterize;
  ordinary non-parameterized recordings are unaffected (#1398).
- Android covered-state publication now has one owner: same-window surfaces remain visible for
  diagnosis, while the daemon marks exactly ordered covered controls non-actionable with
  `interactionBlocked: "covered"`. Helper-only `drawing-order` stays private rather than entering
  the snapshot contract, sparse floating overlays remain usable, and API 23 fails conservative with
  the existing `androidSnapshot.occlusionScanUnavailable` disclosure (#1832).
- iOS regular `snapshot --depth` now measures depth after structural accessibility wrappers
  collapse. The recursive-tree backend follows a bounded presented-depth frontier, so controls
  that fit the requested regular depth are no longer lost behind raw wrappers; raw `--depth`
  remains a traversal-depth limit. Flat query recovery is limited to one presented level, and
  private AX does not claim deeper regular-depth completeness until it has a hierarchy-aware
  frontier (#1797).
- iOS regular snapshot nodes now publish presentation-owned effective geometry through the existing
  `rect` field: backend-reported frames remain available to acquisition, while regular output uses
  the viewport and declared scroll-clip intersection. Raw snapshots and direct element reads retain
  reported geometry (#1797).
- Android recording-session commands now warn when blocking-dialog readiness inspection fails open. The requested command still runs, but the successful response discloses that readiness could not be inspected and preserves the inspection error's actionable hint, including `pnpm build:android` when the snapshot helper is unavailable (#1895).
- Breaking (device selection): when a command needs one concrete device, carries no `--device`/`--udid`/`--serial`, and more than one candidate is equally preferred, agent-device now refuses with `AMBIGUOUS_MATCH` and the candidate list instead of quietly picking one. Established preferences are unchanged — virtual over physical, booted over offline, and the Apple kind/target ranking — so a single booted emulator beside offline ones still resolves, an existing session binding still resolves (its identity is already fixed), and explicit selectors still resolve. What no longer happens is choosing between two equally booted devices by discovery order or alphabetically: that produced a **successful response describing a device the caller never selected**, and reads are no safer than writes there. `devices` and other genuinely multi-device commands never enter singular resolution and are unaffected. The error carries the bounded candidate list in the declared `devices` details domain, so CLI and MCP print it, with a hint naming the right selector for the platform (`--serial` for Android/HarmonyOS, `--udid` for Apple, or `--device "<name>"`).
- `--udid` with `--platform android` (and `--serial` with an Apple platform) now fails as the flag mistake it is — `INVALID_ARGS` naming the right flag — instead of reaching device resolution and answering `No Apple device with UDID emulator-5580` for an explicitly Android request. `--udid` addresses Apple devices, `--serial` addresses Android and HarmonyOS; matching pairs and requests that name no platform are unchanged.
- Breaking (`--session-lock strip`): a device selector that names a different device than the bound session is no longer silently discarded. `strip` exists to drop redundant platform/scope selectors; when it also dropped `--udid`/`--serial`/`--device`, the command kept running against the *bound* device instead of the one the caller named — a wrong-device action that looks like a success. Such a request now fails with `INVALID_ARGS` under both `reject` and `strip`, and the error carries the two identities structurally (`requestedDevice`, `boundDevice`) plus a hint offering the two real recoveries: close the bound session if the requested device is intended, or remove the selector if the bound device is. The hint no longer suggests `--session-lock strip` for an identity conflict, since following that advice is what produced the wrong-device run. Scope-only stripping (`--platform`, `--target`, `--ios-simulator-device-set`, `--android-device-allowlist`) is unchanged.
- iOS regular snapshots now apply one backend-neutral eligibility rule after every capture backend: a node survives when its accessibility type is interactive or it carries a non-empty label, identifier, or value. This removes the tree backend's extra "hittable non-Other" membership path and drops unlabeled decorative nodes consistently; labeled images, identifier-only nodes, and value-only nodes still survive. Raw snapshot membership is unchanged.
- iOS regular snapshots now run one shared clip fold inside presentation for every capture backend (#1797). Backends serialize reported facts -- every traversed node, at raw traversal depth -- and presentation alone decides what the viewport and scroll clips hide, books the scroll hints, and collapses depth; no backend carries its own copy of that interpretation anymore (the copies are what produced the scroll-overflow leak class, #1784). Three intentional edge deltas ride along, all in the direction of one backend-neutral rule: sub-pixel content-free decorations are now dropped by every backend (previously private-AX only); labeled offscreen Application/Window carriers now survive on every backend (previously tree only), still never hittable; and a query-sweep recovery snapshot without `-i` no longer lists offscreen elements. Nothing outside its clip, and nothing without geometry, is ever `hittable` in a regular snapshot, whatever the backend reported.
- iOS `snapshot --raw` is now the acquired accessibility tree on every backend that can serve it (#1797). A raw request that recovered onto the private-AX backend — the route an app whose XCTest tree capture fails takes — returned the *regular* projection's viewport-pruned nodes labeled raw: everything scrolled out of the viewport, and every sub-pixel decoration, was missing from the one view whose purpose is showing what the pruned view hid. Raw now keeps every node the backend serialized, at traversal depth, and `--depth` still narrows it (for raw, presented depth *is* traversal depth). Two structural rules replace the hand-synchronized ones: the raw capture plan is derived from each backend's declared ability to serve raw, so the interactive query sweep — which has no hierarchy to return — cannot be planned for a raw request; and presentation refuses an acquisition captured for the other projection instead of relabeling it, dropping that tier with a structured failure. Breaking in the same direction: `snapshot --raw -i` now returns the acquired tree instead of an interactive-filtered one — `-i` narrows the regular projection, and the pair used to produce a third membership rule that differed per backend. Regular and `-i` output is unchanged. Backends now read one derived capture hint rather than the request itself, so what a capture is allowed to skip is stated once, next to the proof that skipping it keeps the projection complete.
- Android `snapshot --raw` is now the acquired accessibility tree (#1832 C3): the regular-projection classifiers for nodes Android marks invisible and stale application windows no longer run at parse time, so `--raw` keeps everything the helper serialized (normalization only). Covered same-window surfaces are publication annotations rather than membership pruning. Also: Android blocking-dialog recovery now reads the same daemon presentation an agent's `snapshot` sees instead of a hand-rolled subset, and acts on its occlusion result — a stale "App isn't responding" surface left under the foreground one no longer triggers recovery, and a covered "Close app" is never tapped ahead of the visible one; the Android freshness route signature no longer keys on `role`, a field the Android backend never carries; and the Android helper's declared fidelity residues (no `checked`/`checkable`/`long-clickable`, 5000-node cap before scoping, API-level cache-reset divergence) are recorded in `CONTEXT.md`.
- `agent-device mcp` now carries its own usage guidance, so MCP-only clients (Codex CLI, Cursor, custom agents) no longer depend on a separately installed skill (#1833). The handshake `instructions` — returned by both `server/discover` and, newly, the legacy `initialize` — is a compact (< 2 KB, the Claude Code truncation limit) workflow card: start with `open {app, foreground: true}` instead of probing, act with `settle: true` and continue from the diff, verify with `wait`/`is`/`get`/`find`, copy `@refs` byte-for-byte, recover from sparse/AX-unavailable, follow error hints, `close`. A new MCP-only `help` tool serves the full guides on demand: no `topic` returns the CLI's decision card; `topic` returns `agent-device help <topic|command>` verbatim (workflow, gestures, scripting, tv, macos, web, remote, debugging, …, or any tool name for its complete flag reference), prefixed with the one-line CLI→tool-property mapping. `help` is router-owned rather than a command descriptor, so it appears in `tools/list` only — not in the CLI, Node client, or `batch` — and its description tells the model it is not a startup step. Legacy `initialize` gains the optional `instructions` field; no other legacy field changes.
- Android `snapshot --scope` (and every selector command's `--scope`, e.g. `press "Save" --scope Panel`) now resolves scope exactly once, inside the Android projection, under the shared scope specification: the scope root is the first node **in document order** whose label, value, or identifier contains the scope text (case-insensitive) **and whose subtree still has content in the projection you asked for**, the result is that subtree re-rooted at depth 0, and no match returns an empty snapshot (#1832). That second clause is what makes `snapshot -i --scope panel` return the button inside a structural container `-i` drops, and stops a decorative heading that happens to match from emptying the snapshot. Before, Android ran two passes with contradictory rules — a breadth-first platform match that fell back to the full tree on a miss, then the daemon's document-order pass — so a shallower later container could win over an earlier match, and an interaction capture whose scope reached only the daemon layer was silently unscoped. `--depth` under `--scope` counts from the scope root, filtering the depths the response prints (a node shown at depth 0 is never hidden by `--depth 0`), and ancestor context above the scope root (a clickable row, a list) still shapes `-i` membership inside it. The rule is pinned by `contracts/fixtures/snapshot-scope-policy.json`, the same golden table the iOS runner consumes (#1797).
- New `hover <x y|@ref|selector>` command for `--platform web` (#1783). It moves the pointer over the target without pressing, so hover-gated UI — a message row's `...` toolbar, a menu that opens on pointer enter — becomes reachable through agent-device the way it already was through the underlying `agent-browser` backend (`mouse move`). It is a member of the targeted-touch family: same `@ref`/selector/coordinate targeting, occlusion and off-screen guards, and `--settle` (the settled diff carries the revealed controls with fresh refs, e.g. `+ @e4 [button] "Delete"`), but no `--verify`, since hover reveals rather than activates. `hover @ref` publishes as a portable selector line in recorded scripts, and the Node client exposes `interactions.hover`. Hover is a pointer state that touch platforms do not have, so `capabilities` advertises it on web only and iOS/Android/Linux reject it during admission with `UNSUPPORTED_OPERATION` and a hint naming `--platform web`; `longpress` remains the mobile hold-gesture verb.
- Internal: session recording is now derived from the script-publication lifecycle instead of being stored beside it. `SessionState.recordSession` is removed; `isRecordingPublication` answers the question from the aggregate (ordinary authoring records only while ARMED, a repair transaction records for its whole lifetime). The stored flag was a second source of truth that handler surfaces set directly, which is how #1533's aborted-recording drift arose — no surface can now arm recording without moving the lifecycle that authorizes it, and the script writer's publication gate is answered entirely by the aggregate. Behavior-preserving: the derivation reproduces what the flag held at every transition.
- Fixed: a script recording aborted by a second `open` is no longer published by a later bare `close` (#1533). `open <app> --save-script` followed by a second successful `open` terminates the recording and warns "Script publication was aborted…", and `close --save-script` correctly refuses it with "Retry with plain close; it will tear down the session without writing." But when that second `open` itself carried `--save-script`, the flag re-armed recording behind the terminal status, and a bare `close` then wrote the full session log to disk — publishing a recording the caller had been told was aborted, and breaking the promise the refusal makes. An aborted authoring lifecycle is now terminal by construction: `--save-script` arms nothing on any surface that handles it — the re-open builder, the close finalizer, and the recorded-action ingress — and the script writer refuses the lifecycle from every path that reaches it (bare `close`, teardown, idle-reap, active publication). This also stops an aborted session from paying recording-time costs it can never publish: a re-opened aborted recording no longer keeps the direct iOS selector fast paths for `click` and `get` disabled. Armed recordings, published recordings, and every repair transaction are unaffected.
- `agent-device mcp` now serves the stateless MCP `2026-07-28` revision alongside the handshake-based revisions it already spoke, as the spec's "dual-era server". Modern clients probe `server/discover`, which advertises the supported revisions, the tools capability, and server identity; their requests declare a protocol version in `_meta`, and their results carry `resultType: "complete"` plus `_meta["io.modelcontextprotocol/serverInfo"]`. `tools/list` and `server/discover` now return the `ttlMs`/`cacheScope` cache hints, so a client can cache the 55-tool, ~223KB tool list for an hour instead of re-fetching it on every start; the list was already emitted in a deterministic (sorted) order, which is the other half of what makes it cacheable. Each revision is answered on its own wire contract: a request declaring `2025-11-25` or `2025-06-18` through modern framing still gets the legacy result shape, and `initialize` never agrees to `2026-07-28`, which has no handshake to establish. A declared revision this server does not implement is rejected with `UnsupportedProtocolVersionError` (`-32022`) naming the ones it does, rather than being served under a version the client did not ask for, and modern framing that omits its required `protocolVersion`/`clientCapabilities` metadata — or supplies a `clientInfo` that is not a valid `Implementation` — is rejected as invalid params. `initialize` and `ping` were removed in `2026-07-28`, so a modern-framed call to either is answered `-32601` rather than served inside a `resultType: "complete"` envelope. Responses to legacy clients are unchanged byte-for-byte — `initialize` and `ping` are still served, and no cache, `resultType`, or `_meta` field is added to their results. Nothing here affects the CLI, Node, or daemon surfaces: the stdio transport, the tool set, and every tool's input/output schema are untouched.
- Fixed: the MCP `initialize` handshake now answers with the protocol revision the client requested when it is one this server implements, instead of always answering `2025-11-25`. A client pinned to `2025-06-18` was told to speak a revision it had not asked for, which the lifecycle contract answers by disconnecting.
- `agent-device help workflow` is now a compact ~8KB card instead of a ~41KB dump; the same depth still exists, split into `help scripting` (save-script, secret-safe fills, batch JSON, replay divergence/repair, recording) and `help gestures` (multi-touch shapes and platform quirks), plus a few paragraphs folded into the topics that already owned the subject (`help debugging`, `help physical-device`, `help validate`). Every `help <topic>` first line is now `agent-device <version> — <topic>` so an agent can read the installed version from its mandatory first help read instead of a separate `agent-device --version` call.
- Cloud iOS (BrowserStack, AWS Device Farm): `snapshot` and `diff` no longer fail with `SESSION_NOT_FOUND` on a live provider session (#1658). The app-session guard they ran belongs to the local XCUITest runner, which must attach to a target app; a cloud capture reads the provider's own driver session and needs no app identity, so the guard now applies to local Apple targets only. Relatedly, a cloud iOS `open com.example.app` now records that bundle id on the session — the provider path skips local app resolution (no simctl/devicectl reaches a hosted device), and used to drop an explicitly spelled bundle id along with it, leaving the session with no app identity at all. Opening a second bundle id replaces the first, matching the local path, where an explicitly spelled target always wins over the session's current app; deep links, display names, and bare `open` still keep the app already tracked.
- Cloud `fill` (BrowserStack, AWS Device Farm) now witnesses that the field it tapped actually holds text-entry focus before sending its keys, instead of dispatching tap and keys in back-to-back requests (#1658). A WebView input — an OAuth/SSO page in a Safari view controller, for example — takes first responder asynchronously, so the keys used to land with nothing focused while `fill` still answered "Filled N chars"; tapping and filling as two separate commands worked only because the round trip between them gave the field time to focus. The witness is the focused element's own geometry: `fill` polls the active element and proceeds only once it contains the point it tapped, which is the one signal that identifies *which* field took focus. Keyboard visibility cannot — it reads the same before and after a second fill into an already-open form, so it could not tell a focused password field from the email field the previous fill left focused. The response discloses `textEntryReadiness`: `focused-element`, or `keyboard-shown` when the driver has no active-element route but the keyboard rose from hidden after the tap. Both describe a fill that witnessed focus before typing; there is deliberately no value for typing without evidence, because nothing renders this field and such a value would reach a caller as an ordinary success. Breaking: when focus cannot be witnessed, cloud `fill` now FAILS with `COMMAND_FAILED` / `text_entry_focus_not_observed` and sends no keys, instead of typing into whatever holds first responder and answering "Filled N chars" — a fill with no witness must not read as a filled field. That covers a tap that focused nothing, a keyboard already up on a driver that cannot name the focused field, and a driver that reports neither (`text_entry_focus_unobservable`, which points at `press` + `type` as the deliberate way to enter text unwitnessed). Only a positively classified unimplemented route counts as unsupported, so a dead session, an auth rejection, or a grid outage surfaces instead of degrading into a blind text entry.
- Changed mutating selector ambiguity semantics (press/click/fill/longpress): duplicate accessibility wrappers collapse only when every match forms one ancestor-descendant chain resolving to the same actionable node. Matches in distinct subtrees now fail fast with `AMBIGUOUS_MATCH` and a bounded, immediately reusable candidate-ref frame; visible/depth/area geometry no longer silently picks a mutation target. The direct iOS XCTest path now counts raw exact matches before hittability and delegates ambiguity to the same runtime rule. AppControlBench provenance: element-14 ran on 0.20.5; this change is intended for 0.20.7+, and comparative benchmark reports should note that it can replace a wrong-success recovery loop with one candidate-pick turn while occasionally adding that turn for genuinely distinct duplicates.
- `scroll` and `back` now accept `--settle` (with `--settle-quiet` and `--timeout`), collapsing scroll-then-observe and back-then-observe into one call (#1638). The response carries the same settled payload the touch commands return — verdict, changed-lines diff with fresh refs on added lines, the unchanged-interactive tail, and `refsGeneration` when the settled tree was stored — and is best-effort: it never fails the action. One difference is deliberate: `scroll`/`back` resolve no element, so the diff baseline is the session's stored pre-action tree ("the last tree you observed") rather than a freshly resolved pre-action capture. Both commands now also preserve the daemon on timeout, like the other settle-capable commands.
- Security: repository `./agent-device.json` now accepts only project-safe automation defaults. It rejects daemon endpoint/auth/transport/server settings, tenant/run/lease selectors, provider/cloud and Metro connection fields, headers, executable reporter modules, local write destinations, and other operator-controlled values before local module loading or any daemon health/RPC request. Put remote endpoint and token together in protected CI environment variables, user config, an explicit `--config` file, or the existing `connect`/`--remote-config` workflow. Daemon auth tokens no longer travel in serialized command flags.
- `viewport` is now rejected during capability admission on Apple targets instead of reaching the device and failing inside dispatch. No Apple backend can resize a screen — simulator and device geometry is fixed by the selected device type — so `viewport` on iOS/iPadOS/tvOS/macOS now fails with `UNSUPPORTED_OPERATION`, `viewport is not supported on this device`, and a hint pointing at `--platform web` and at picking a different simulator. `capabilities` no longer advertises `viewport` on Apple targets. Web viewport resizing (`agent-device viewport 1280 900 --platform web`) is unchanged, and Android was already denied.
- `--save-script` is now accepted only by the commands that declare it — `open`, `close`, and `replay`. A hand-built daemon request (or a `batch` step) that set `saveScript` on any other command, such as `record` or `trace`, used to arm script publication and could write a `.ad` artifact; it is now rejected with `INVALID_ARGS` before the request reaches admission, the device, or any handler. CLI, Node, and MCP usage of `--save-script` on its documented commands is unchanged.
- `diff screenshot` no longer runs the retired best-effort OCR and non-text analyzers. Their optional `ocr` and `nonTextDeltas` fields remain in the result type for source compatibility but are no longer emitted; use the baseline/current images and diff artifact with vision for qualitative interpretation.
- Breaking: removed the deprecated `--session-locked` and `--session-lock-conflicts` flags. Use `--session-lock reject|strip` instead; passing either old flag now fails with `Unknown flag: ... Use --session-lock reject|strip instead.`
- Breaking: removed the `replay export --format` flag. `replay export` always writes Maestro YAML.
- Breaking: removed the unused `LeaseAllocatePayload`, `LeaseHeartbeatPayload`, and `LeaseReleasePayload` type exports from `agent-device/contracts`. Lease request metadata is fully described by `DaemonRequestMeta`.
- Maestro compat: `assertVisible` and `assertNotVisible` now accept `childOf` for ancestor scoping, matching `tapOn` (#1294).
- Breaking: removed deprecated gesture duration and rotate velocity inputs (#1218).
  - `swipe x1 y1 x2 y2` no longer accepts a trailing `durationMs` positional; use `gesture pan x1 y1 (x2-x1) (y2-y1) durationMs` for deliberate timed drags.
  - Maestro `swipe` operations with a duration continue to normalize to `gesture pan` with the `endpoint-hold` execution profile, preserving the Maestro-compatible fast-swipe-then-hold behavior on iOS.
  - `gesture fling direction x y` no longer accepts a trailing `durationMs` positional; use `gesture pan` for timed movement.
  - `gesture swipe preset` no longer accepts a trailing `durationMs` positional; use `gesture pan` for timed movement.
  - `gesture rotate degrees [x] [y]` no longer accepts a trailing `velocity` positional; rotation pacing is derived from `degrees`.
  - MCP/Node schemas no longer advertise `velocity` or `durationMs` on `swipe`/`fling`/`gesture swipe`; `durationMs` remains on `gesture pan` and `gesture transform`.
  - A `.ad` script that still carries a removed positional now fails when the script is parsed, before the replay executes any device action, naming the line and its rewrite (for example `swipe accepts 4 arguments: x1 y1 x2 y2 (line 6). The trailing durationMs positional was removed: use "gesture pan 197 650 0 -350 300" ...`). Previously the script ran up to that step and then failed as a replay divergence.
  - Published the [gesture migration guide](https://agent-device.dev/docs/migrating-gestures) covering CLI, Node.js, MCP, and saved `.ad` recordings, plus the deprecation policy the next such removal follows (#1216).
  - `replay export` now writes an explicit `duration: 100` for `swipe` — the canonical fling duration — instead of omitting it and letting Maestro apply its own 400ms default. Maestro flows replayed by `agent-device` are unaffected; a timed Maestro `swipe` still normalizes to `gesture pan` with the `endpoint-hold` profile.
- Breaking: the deprecated `rotate` CLI command alias has been removed. Use `orientation` instead; invoking `rotate` now fails with `rotate was renamed to orientation; for the two-finger gesture use: gesture rotate`.
- Breaking (ADR 0014, session ref-frame lifetime): a mutation through an `@ref` now expires the session's ref frame, so a later ref mutation without a fresh observation fails closed with a typed `details.reason` (`ref_frame_expired`, `ref_generation_mismatch`, `plain_ref_requires_complete_frame`, or `ref_not_issued`) instead of acting on a possibly-navigated screen. A ref-oriented sequence that performs several mutations must re-`snapshot` between them, consume an honestly issued `--settle` ref in pinned `@eN~s<gen>` form, or use selectors. Enforcement applies on every platform, not just iOS. Legacy hand-written `.ad` scripts that reuse several bare refs from one snapshot must capture between mutations or use selectors.
- Ref reads resolve against the authorized ref frame's source tree, so an internal read-only capture (including Android freshness) can no longer retarget an admitted `@ref` by positional coincidence. Read-only ref consumers keep the structured staleness warning while the frame retains the ref's evidence.

## 0.15.0

- Breaking: `apps` discovery and public app-list helpers now default to user-installed apps. Use `--all` or `filter: 'all'` to include system/OEM apps.
- Breaking: removed the `agent-device/android-apps` public subpath. Use the Android app helpers from `agent-device/android-adb`.
- Breaking: removed the `agent-device/daemon` public subpath. Use `agent-device/contracts` for daemon request/response types.
- Breaking: removed public local ADB bypass/selection helpers such as `spawnAndroidAdbBySerial` and `resolveAndroidAdbProvider`; use `createLocalAndroidAdbProvider(device)` or pass providers directly to the helpers from `agent-device/android-adb`.
- Added Android ADB provider helpers for exec, stream, clipboard, keyboard, app lifecycle, logcat, and port reverse workflows.
