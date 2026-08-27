import { listCliCommandNames } from '../command-catalog.ts';
import {
  formatMaestroCompatibilityReference,
  MAESTRO_COMPATIBILITY_ADR_URL,
  MAESTRO_COMPATIBILITY_ISSUE_URL,
} from '@agent-device/maestro';
import { helpBody } from '../commands/command-text.ts';
import {
  DEVICE_SELECTION_FLAG_KEYS,
  getCliCommandSchema,
  getCommandSchema,
  getFlagDefinitions,
  GLOBAL_FLAG_KEYS,
  type CommandSchema,
  type FlagDefinition,
  type FlagKey,
} from './command-schema.ts';
import { buildCommandUsage } from './usage.ts';
import { readVersion } from '@agent-device/host-kit/version';
import { renderCliHelpOverview } from './cli-help-overview.ts';

const CONFIGURATION_LINES = [
  'Default config files: ~/.agent-device/config.json, ./agent-device.json (project-safe defaults only).',
  'Use --config <path> or AGENT_DEVICE_CONFIG for explicit connection/provider defaults; project config cannot select endpoints or credentials.',
] as const;

const ENVIRONMENT_LINES = [
  { label: 'AGENT_DEVICE_SESSION', description: 'Explicit session name' },
  { label: 'AGENT_DEVICE_PLATFORM', description: 'Default platform binding' },
  {
    label: 'AGENT_DEVICE_SCREENSHOT_SCALE',
    description: 'Default screenshot scale factor',
  },
  { label: 'AGENT_DEVICE_SESSION_LOCK', description: 'Bound-session conflict mode' },
  { label: 'AGENT_DEVICE_DAEMON_BASE_URL', description: 'Connect to remote daemon' },
  {
    label: 'AGENT_DEVICE_DAEMON_AUTH_TOKEN',
    description: 'Remote daemon service/API token',
  },
  {
    label: 'AGENT_DEVICE_CLOUD_BASE_URL',
    description: 'Bridge/control-plane API origin for cloud auth and /api-keys',
  },
] as const;

const EXAMPLE_LINES = [
  'agent-device open Settings --platform ios',
  'agent-device open https://example.com --platform web',
  'agent-device snapshot -i',
  'agent-device fill @e3 "test@example.com"',
  'agent-device replay ./session.ad',
  'agent-device test ./suite --platform android',
] as const;

const WAIT_FAILURE_CONTRACT = `Wait failure contract:
  Read the verdict from error.details.reason in --json, not the message text.
  wait_target_absent: a readable capture ran and found no match.
  wait_capture_stalled: no readable capture finished before the deadline -- retriable.
  wait_deadline_exceeded: a later capture used the remaining budget after an earlier readable one.
  wait_landmark_identity_mismatch: a replay destination guard found the selector but not the recorded identity.
  wait_stable_timeout: wait stable never saw a stable UI -- not an absence verdict.
`;

const HELP_TOPICS = {
  commands: {
    summary: 'Full command catalog, global flags, configuration, and environment',
    body: 'agent-device help commands',
  },
  'manual-qa': {
    summary: 'Follow manual test scripts with exact interactions and verification',
    body: `agent-device help manual-qa

Use this when asked to follow a manual QA script, test case, checklist, acceptance flow, or user-provided instructions.

Contract:
  Execute the script. Do not explore unrelated screens, read app source, invent missing requirements, or broaden scope.
  Stop and report ambiguity when a required target or expected result is not visible after the documented recovery steps.

Loop:
  1. Open the requested app; use --relaunch only when the script needs fresh state.
  2. Run snapshot -i to get current refs for the next step.
  3. Run press/fill/click/longpress <ref-or-selector> --settle for each mutating step.
  4. Treat a settled:true diff as the next observation. Do not add wait stable or another snapshot when the diff already shows the next target or expected result.
  5. If --settle prints not settled, follow its hint before the next ref-based action.
  6. Verify named expectations with wait text/selector, get, is, find, or the settled diff. A bare screenshot/snapshot is not verification for a named expectation.
  7. Close the session when the script ends.

Command shapes:
  agent-device open com.example.app --relaunch
  agent-device open https://example.com/deep-link
  agent-device snapshot -i
  agent-device press @e12 --settle
  agent-device press 'label="Follow"' --settle
  agent-device fill @e13 "qa@example.com" --settle
  agent-device wait text "Order placed" 3000
  agent-device close
  --relaunch forces fresh app state; a deep link/URL open does not need it. Labels with an apostrophe or quote (label="Don't leave") are shell-quoting hazards: prefer the @ref from the latest snapshot/settle output over quoting the literal label.

Targets:
  Prefer refs from the latest snapshot -i or settled diff. Use durable selectors when the label/id is known: label="Search", id="submit", role=button label="Follow". If label text matches both a field and its caption, target the field with label="Email" editable=true.
  For text fields, use fill <target> <text> --settle to replace the field value; use type only to append to an already-focused field.
  Do not use placeholders such as @ref, @eN, <button>, or <selector> in a final command plan. If the ref is unknown, first run snapshot -i.
  Coordinates are fallback-only after refs/selectors fail or accessibility omits the target; use screenshot or snapshot -i --json to choose a visible center point.

Recovery:
  Network/typeahead result missing: wait text "Expected result" or wait <selector>.
  Keyboard visible over the next target: the on-screen keyboard usually does not block presses, so press the target directly instead of dismissing. If the press fails or reports no visible effect, scroll the target into view or use keyboard enter when submission is wanted.
  Sparse or recovered accessibility snapshot: use screenshot as visual truth, leave the bad screen if needed, then retry snapshot -i.
  Non-hittable success hint: verify with the settled diff or snapshot; retarget by a better ref/selector if the UI did not change.

${WAIT_FAILURE_CONTRACT}`,
  },
  maestro: {
    summary: 'Supported Maestro YAML commands, grammar, and runtime boundaries',
    body: `agent-device help maestro

Run Maestro compatibility flows with replay <flow.yaml> --maestro or test <path> --maestro. Bind an iOS or Android target with --platform or an existing session.

${formatMaestroCompatibilityReference()}

Unsupported syntax fails loudly rather than being skipped. Architecture, performance tradeoffs, and declared conformance divergences: ${MAESTRO_COMPATIBILITY_ADR_URL}
Focused compatibility request: ${MAESTRO_COMPATIBILITY_ISSUE_URL}`,
  },
  workflow: {
    summary: 'Normal agent-device bootstrap, exploration, and validation loop',
    body: `agent-device help workflow

Command shapes, refs, selectors, waits, recovery, and platform limits for the default open -> snapshot -i -> settle -> verify -> close loop.

Command shape:
  Command lines only -- no prose, numbering, fences, pipes, or grep/head/tail/jq on agent-device output; raw output carries the refs/hints the next step needs. Subcommand first, then positionals, then flags: agent-device open com.example.app --session checkout --platform android --relaunch
  Chain confident consecutive steps with &&: press 'label="Search"' --settle && fill 'label="Search"' "query" --settle. Fall back to one command at a time when a step is uncertain (ambiguous match, network-backed result, unseen screen).
  Refs look like @e12; use the exact ref from the latest snapshot -i, never a placeholder (@ref, @eN, @Label_Name). Pin with ~s<n> (press @e12~s4); iOS rejects a stale pinned ref -- refresh with snapshot -i or use a selector.
  close = agent-device close. App back is back; system back is back --system. Taps are press/click. type never takes --settle: run type, then diff snapshot to verify. Known flow: batch --steps-file ./steps.json (help batch).
  Gestures: scroll/swipe for lists/flicks; gesture pan|fling|pinch|rotate|transform|drag for multi-touch. Shapes and platform quirks: help gestures.

Bootstrap:
  open --foreground -> snapshot. Selection: explicit --device/--udid/--serial, then session, booted/bootable local, or provider; --platform/--target only filter. Ambiguous/empty fails with bounded retry selectors; no provider fallback.
  Install arguments are app/package id then artifact path: agent-device install com.example.app ./dist/app.apk --platform android, then open <id> --relaunch for fresh state. Use reinstall only when explicitly requested.
  Unknown app id: devices, then apps, then open <discovered-app-id>. Never open artifact paths or invent package ids; ask if lookup misses the target.
  Apple CI: prepare ios-runner after boot/install, before replay/test (help prepare). Remote/cloud: connect -> open -> commands -> close -> disconnect (help remote). Reusable scripts, secret-safe fills, replay repair: help scripting.

Snapshots and refs:
  snapshot reads visible state; snapshot -i gets current interactive refs only -- the fast path before an interaction. Default text is agent-facing and token-efficient; --raw/--json only for the full provider tree.
  Legend: @e12 [button] label="Add to cart" enabled hittable -> press @e12. [off-screen below] -> scroll down (a hint, not a ref).
  Refs stay valid until you press/click/fill/type/scroll/back/wait-for-async-UI, or otherwise change app state; open/--relaunch clears the stored snapshot outright.
  Prefer --settle and continue from its settled diff when it shows the next target; refresh with snapshot -i only when you did not settle, it reported not settled, or its output lacks what you need. A known selector/label after a mutation is often enough, since interaction commands refresh state internally.
  Truncated preview: snapshot -s @e12 (the current concrete ref), not get text. Missing target in a list: scroll down/up (not bottom/top unless the task wants the edge), then snapshot -i. TV/D-pad focus: help tv.

Selectors:
  id="field-email", label="Allow", role=button label="Search" -- not bare role keys (button="Search"); no CSS selectors/--selector/--text/raw x-y when refs/selectors exist.
  Mutating selector ambiguity: press/click/fill/longpress collapse duplicate accessibility wrappers only when every match is one ancestor-descendant chain resolving to the same actionable node. Matches in distinct subtrees fail with AMBIGUOUS_MATCH and a bounded candidate list; geometry never chooses a winner. Retry one printed candidate ref (pinned to refsGeneration) or narrow the selector with role/id/longer text. Read-only commands and replay suggestions retain their declared resolution policies.
  hittable: false on a resolved element does not block dispatch (iOS AX flags are unreliable on deep RN trees); press/fill/click return targetHittable: false plus a hint -- verify or re-target, not a failure.

Text entry:
  fill replaces; type appends to an already-focused field: fill 'id="field-email"' "qa@example.com"; type "Handle with care" --delay-ms 80
  fill <target> "" clears the field (replace with nothing); the empty argument must be present -- fill <target> alone is a missing argument.
  Plain fill/type first; if an iOS debounced/search-as-you-type field drops characters, retry with --delay-ms before clipboard paste.
  The keyboard usually does not block interactions -- press the next target directly. keyboard dismiss taps its own dismiss key when one exists, else UNSUPPORTED_OPERATION. Android: try dismiss before back. iOS: when both fail, do not tap a static text/heading hoping it is safe; prefer type "\\n" to submit.
  iOS paste-prompt limits and Android IME/handwriting capture quirks: help debugging.

Session ordering:
  Stateful commands (open/press/fill/type/scroll/back/alert/replay/batch/close) run serially within one session. Parallelize only read-only commands, or separate sessions/devices.

Read-only and waits:
${WAIT_FAILURE_CONTRACT}
  snapshot/get/is/find answer read-only questions; snapshot -i only when refs are needed. --settle confirms local UI quieted; for results that arrive later (network/debounce), follow with wait text "Expected result" or wait <selector> instead of polling.
  wait stable [quietMs] [timeoutMs] (defaults 500/10000) is the fallback for open/relaunch/navigation, or an intentionally-unsettled mutation -- not after a --settle whose diff already shows the change. Ambiguous find: add --first or --last.

Navigation:
  Pick a coordinate gesture point near the target's center, away from edges/tab bars/nav bars/the home indicator (they trigger system navigation instead); macOS context menus are secondary clicks (help macos). Action sheets/menus/camera screens are normal UI: snapshot -i, press by label/ref, handle permission sheets via UI/alert. If back is ambiguous, prefer a nav/back ref, tab-bar ref, or deep link over repeating it.

Validation and evidence:
  Nearby mutation diff: diff snapshot -i; with no prior snapshot it initializes the baseline (zero changes) instead of failing.
  Named expectations need the exact text/selector via wait/is/get/find -- a bare screenshot/snapshot is not verification. Before declaring a task done, confirm the requested end state is actually visible on the current screen, scrolling it into view if needed; get text alone, or stopping one screen early, is not enough.
  When an action only reveals or reaches a target, verify the exact target named, not just the action. Prefer testIDs/ids/selectors over visible text. Icon/tappable proof: screenshot --overlay-refs; if snapshot is sparse/AX-unavailable, use plain screenshot and coordinates, then retry snapshot -i on another screen.
  iOS merged: child ref => press it; else press parent @ref --settle. Names are not selectors.
  Perf/memory/log/network/trace/crash: help debugging. Recording, save-script, batch, replay repair: help scripting.

React Native: help react-native for Metro/Re.Pack reload, DevTools, RN overlays. JS-only change: metro reload, find "Home"; open --relaunch for native reset.

Lifecycle facts (trust these instead of probing): open without --relaunch is idempotent-foreground; --relaunch restarts it. close keeps a healthy iOS runner warm by default; runners and daemons both self-idle after 5 minutes, and a stale lease reclaims automatically -- a live owner still rejects with "already owned by another agent-device daemon". Env vars: help physical-device.

Escalate:
  help manual-qa scripted manual QA
  help dogfood exploratory QA report
  help validate engineering self-validation
  help debugging logs, network, alerts, traces, text-entry
  help scripting recording, save-script, batch, replay repair
  help gestures multi-touch gesture shapes/quirks
  help tv Android TV, tvOS, Vega VVD remote
  help react-devtools RN perf/profiling, hooks, renders
  help react-native RN hazards, Metro/Re.Pack, routing
  help remote remote/cloud config, lease, tunnels
  help macos desktop, frontmost-app, menu bar
  help web minimal browser loop
  help ios-system-ui SpringBoard, widget, system-UI`,
  },
  scripting: {
    summary: 'Reusable scripts, secret-safe fills, batch JSON, and replay repair',
    body: `agent-device help scripting

Use this for reusable .ad script authoring (save-script), scripted destination guards, secret-safe fills, batch multi-step JSON, replay divergence/repair, and evidence recording.

Script paths are the caller's:
  replay <path> and test <path-or-glob> resolve and read on the machine running the command, then send the script content (Maestro runFlow includes too) with the request. The same flows therefore run against a local daemon and against a remote one (AGENT_DEVICE_DAEMON_BASE_URL) with no copy step, and a missing script fails immediately, naming the path you typed. --save-script writes on the DAEMON host and is rejected against a remote daemon.
  test --json marks a failed test with infrastructure: true only when the owning runtime classified a device, runner, boot, or transport failure. It remains a failed test; consumers may use the tag to distinguish "the oracle did not run" from a behavioral replay divergence without weakening either gate.

Reusable open-to-destination scripts:
  Arm recording on the first open, perform the full journey, verify the destination with a selector-targeted wait, then publish without closing:
    agent-device open com.example.app --relaunch --save-script=screen-x.ad
    agent-device press 'id="continue"' --settle
    agent-device wait 'role="heading" label="Screen X"'
    agent-device session save-script
  session save-script [path] [--force] publishes the sole recorded open through the destination guard, omits close, and leaves the session active. The guard is a selector wait on a labeled/id-bearing landmark: its identity is captured while armed and re-verified after the wait resolves at replay time, so a reshuffled screen with the same label elsewhere fails closed instead of false-passing. A duration wait, wait stable, wait @ref, or a selector wait on an unlabeled element is not a destination guard. A second successful open aborts publication; start a fresh session to author again.
  Unparameterized fill/type inputs are literal .ad script content. For a sensitive fill, arm recording first, keep the live value in an env var, and name its replay placeholder explicitly:
    export AD_VAR_PASSWORD='<secret>'
    agent-device fill 'id="password"' "$AD_VAR_PASSWORD" --record-as PASSWORD
  The live app receives the value; recording state and the published script contain only \${PASSWORD}. Reuse the same name for repeated values; --record-as is fill-only, requires an armed recording, and is mutually exclusive with --no-record. Replay with AD_VAR_PASSWORD still set, or pass --env PASSWORD=<value>. Do not record passwords/tokens without --record-as; their literal text is written to the .ad target.

Replay divergence and repair:
  A failing replay/test step returns REPLAY_DIVERGENCE with a bounded report (screen digest, ranked selector suggestions, resume). Fix app state, then resume with replay --from <n> --plan-digest <sha256> (both from the report's resume field) to continue without re-running earlier steps; resume never re-executes skipped steps, so app state there is the caller's responsibility. --from is replay-only; test rejects it. The digest binds the script, includes, effective --platform/--target, and per-action runtime/identity; native .ad interpolation is late-bound so changing only its values keeps the digest, while Maestro environment substitution can change it.
  Native .ad session takeover: replay <file>.ad --keep-session suppresses exactly an authored terminal close and returns the surviving session for continued commands. --update/-u is a no-op (ADR 0012); every divergence already carries the same ranked suggestions.
  Agent-supervised repair: arm replay <file>.ad --save-script[=<out>] before step 1 (armed once; --from continuations do not need it again). Every divergence carries a repairHint: record-and-heal means press the correct control via a blessed @ref from the divergence's screen.refs, recorded, then replay --from <n+1> --plan-digest <sha256>; state-repair means the script is correct but app state is not -- fix state with --no-record actions, then replay --from <n> to re-run the unchanged step; caution means a blind re-press may repeat the mistake; manual means no safe automated repair could be proven. Read-only inspection you run to locate the repair target (snapshot -i, get attrs, find, is) is excluded from the healed script by default; pass --record on a read step you want kept. End the repair with close --save-script[=<out>] (default <stem>.healed.ad); review its diff before promoting it over the original. Running close --save-script before a required resume aborts the repair with no script written.

Batch:
  agent-device batch --steps '[{"command":"open","input":{"app":"settings"}},{"command":"wait","input":{"kind":"duration","durationMs":100}}]'
  agent-device batch --steps-file ./steps.json --json
  Step keys are command, input, and optional runtime -- that is the whole accepted shape. input holds the command's structured fields, not its terminal spelling: a CLI positional becomes a named field (target, text, direction) and a flag becomes a camelCase key (--settle -> "settle":true). Accepted commands, that mapping, and runnable press/fill/snapshot steps: help batch.
  Maestro full-suite validation on connected devices uses one test command with a comma-separated --device list and --shard-all (--shard-split only to split suite entries across devices):
    agent-device test ./e2e/maestro --maestro --device udid1,emulator-5554 --shard-all 2

Recording:
  record start/stop. Default scope is app (needs an active open session); use --scope device/system for whole-screen capture spanning multiple apps/home/settings. --quality medium|high on Android and Apple targets. stop burns touch overlays into the video by default; --hide-touches skips that for the fastest raw recording, and is recommended for gesture-heavy iOS simulator proof videos since overlay timing depends on a stable runner session. Android adb screenrecord has a 180s limit, so long Android recordings return as multiple MP4 chunks while the daemon stays alive; after a daemon restart, record stop recovers only manifest-owned chunks.
  Tracing: trace start ./trace.log, trace stop ./trace.log (path is positional, not --path).`,
  },
  gestures: {
    summary: 'Full multi-touch gesture shapes and platform quirks',
    body: `agent-device help gestures

Full command shapes and platform quirks for touch/pointer gestures beyond scroll/swipe. Read this when a task needs multi-touch, a repeated gesture series, or exact per-platform verification.

Shapes:
  agent-device longpress 300 500 800
  agent-device longpress @e12 800
  agent-device swipe 320 500 40 500 --count 8 --pause-ms 30 --pattern ping-pong
  agent-device gesture pan 200 420 0 -80 500
  agent-device gesture pan 200 420 80 -40 700 --pointer-count 2
  agent-device gesture fling right 200 420 180
  agent-device gesture pinch 0.5 200 400
  agent-device gesture rotate 35 200 420
  agent-device gesture transform 200 420 80 -40 2 35 700
  longpress accepts coordinates, @refs, or selectors; prefer @ref/selector, coordinates only as a fallback. Duration and gesture scale/center are positional. gesture pan is one finger by default; add --pointer-count 2 for a parallel two-finger pan. Keep count/pause/pattern on one swipe: --count (cap 200), --pause-ms (cap 10000ms), --pattern ping-pong; the combined swipe/pause schedule is capped at 60000ms.
  For repeated iOS smoke checks: press <x> <y> --count <n> --jitter-px <n> for tap series, swipe <x1> <y1> <x2> <y2> --count <n> for drag series.

Platform quirks:
  iOS simulator transform/pinch/rotate use private XCTest synthesis for a continuous two-finger pan/scale/rotation path; verify app metrics instead of assuming requested values map exactly to recognizer output.
  Android transform injects a geometric two-finger path; app recognizers may report non-exact pan/scale/rotation -- verify semantic app state or coarse per-component effects instead of exact numeric deltas unless the app exposes stable metrics. If Android needs exact values, prefer isolated gesture pan --pointer-count 2, gesture pinch, or gesture rotate over one combined transform:
    agent-device gesture transform 200 420 80 -40 2 35 700 --platform android
    agent-device wait text "pan changed yes" 3000 --platform android
  tvOS coordinate pan and fling preserve only the dominant direction as a remote swipe; authored endpoints and duration are not preserved.
  Gesture planning prefers the active-app frame; a backend without a gesture viewport resolver falls back to the visible snapshot union, which can be less accurate near edges.
  Rare iOS accessibility gap: a row shown disabled/hittable:false where press reports success but no UI change, or a collapsed composite control with no child refs -- run snapshot -i --json, compute the target center from rects, press x y, then diff snapshot -i. Coordinates are fallback-only; document why you used them.

macOS:
  Context menus are secondary clicks, not long presses: agent-device click @e66 --button secondary --platform macos, then snapshot -i.
  For fast desktop list traversal, prefer fixed pixel wheel steps and batch them when no snapshot is needed between passes:
    agent-device scroll down --pixels 200 --duration-ms 50 --platform macos
    agent-device batch --steps '[{"command":"scroll","input":{"direction":"down","pixels":200,"durationMs":50}},{"command":"scroll","input":{"direction":"down","pixels":200,"durationMs":50}}]' --platform macos`,
  },
  tv: {
    summary: 'Android TV, tvOS, and Vega VVD focus-first remote navigation',
    body: `agent-device help tv

Use this when the target is Android TV, Apple TV/tvOS, or an Amazon Vega OS TV app running in the Vega Virtual Device (VVD). TV surfaces are focus-first: move focus with remote/D-pad buttons, then activate the focused control.

Core loop:
  agent-device open Settings --platform android --target tv --session tv
  agent-device snapshot -i --platform android --target tv --session tv
  agent-device tv-remote press down --platform android --target tv --session tv
  agent-device is focused 'label="Profiles"' --platform android --target tv --session tv
  agent-device tv-remote press select --platform android --target tv --session tv
  agent-device screenshot ./tv-focus.png --overlay-refs --platform android --target tv --session tv

Vega OS:
  Vega OS is driven through the SDK-matched Vega CLI and VDA, not ADB.
  Initial support is VVD-only. Physical Fire TV devices remain unsupported until their discovery, lifecycle, and remote controls have durable hardware evidence.
  Use --platform vega --target tv for the running Vega Virtual Device.
  vega virtual-device start
  agent-device devices --platform vega --target tv
  agent-device open <component-id> --platform vega --target tv --session vega-tv
  agent-device tv-remote press down --platform vega --target tv --session vega-tv
  agent-device tv-remote press select --platform vega --target tv --session vega-tv
  agent-device close <component-id> --session vega-tv
  vega virtual-device stop
  Use a component ID from the app package or Vega SDK tooling; agent-device app inventory is not yet supported.
  Use --serial VirtualDevice for explicit VVD selection.
  The VVD is never booted implicitly; start it with vega virtual-device start.
  Snapshot, screenshot, selectors, install, touch/text/gesture, logs, and performance commands remain unsupported until their Vega backends are implemented.

Buttons:
  tv-remote press up|down|left|right|select|menu|home|back
  tv-remote longpress select
  tv-remote press select --duration-ms 500
  ok, center, and enter are input aliases for select; command output still reports button: "select".
  longpress is CLI sugar for --duration-ms 500. --duration-ms overrides that preset.
  --duration-ms holds a tvOS or Vega OS remote button for that exact duration. On Android TV, any positive duration maps to the ADB longpress form because Android input keyevent has no exact hold duration.
  Vega OS uses the exact hold duration through inputd-cli in the VVD.

Android TV:
  Android TV uses ADB keyevents behind agent-device tv-remote. Keep command plans on agent-device; do not switch to raw adb keyevent.
  Use --target tv when a host has both phone/tablet and TV emulators/devices.

tvOS:
  tvOS is driven by the Siri Remote focus engine, not coordinate taps.
  back maps to the Menu remote button; home maps to the Home remote button.
  Use --platform ios --target tv for Apple TV simulators and devices.

Focus and visual truth:
  On Android TV and tvOS, if snapshot -i exposes a focused node, verify it with is focused <selector>.
  Use wait focused=true only when repeated snapshots preserve focus metadata for the app.
  If the app exposes only a surface view, or focus metadata is transient, use screenshot --overlay-refs, screenshot, or diff snapshot as visual truth and keep moving focus with tv-remote. On Vega OS, use the VVD display as visual truth until capture support lands.
  Do not assume press/click @ref works on Android TV, tvOS, or Vega OS until the desired element is focused.`,
  },
  debugging: {
    summary: 'Targeted failure evidence without dumping stale context',
    body: `agent-device help debugging

Use this when behavior fails, hangs, times out, throws alerts, or needs runtime evidence.

Logs:
  Keep log windows small. Prefer clear, mark, reproduce, then path.
    agent-device logs clear --restart
    agent-device logs mark "before diagnostics retry"
    agent-device press 'id="load-diagnostics"'
    agent-device logs path
  Do not cat a full stale log into agent context. Open or grep only the relevant window when needed.
  logs clear --restart is the compact command to clear old logs and start a fresh capture; do not split it into logs stop, logs clear, logs start.
  On iOS simulators, logs scope by bundle id and resolved app executable, so use this instead of raw simctl log stream predicates.
  On iOS physical devices, logs clear --restart relaunches the session app through devicectl process launch --console so stdout/stderr can be captured.
  For iOS simulator launch-time stdout/stderr, use --launch-console on the direct app launch:
    agent-device open MyApp --platform ios --relaunch --launch-console ./artifacts/app.console.log
  --launch-console is only for direct iOS simulator app launches, not URL opens.

Events:
  Use events for a compact session timeline without dumping full app logs.
    agent-device events
    agent-device events 50 100
  Events preserve command names, status, durations, bounded device/app inventory previews, lifecycle outcomes, artifact basenames, and structural action details such as scroll distance/direction, safe refs, and coordinates. User-entered text, clipboard contents, push/event payloads, selector values, free-form flags/messages/paths, and raw unknown command arguments are omitted or replaced with content-free placeholders. --no-record suppresses action.recorded entries, but request start/finish entries still record command, status, and timing.

Network:
  Use network dump for recent session HTTP traffic parsed from app logs.
    agent-device network dump --include headers
    agent-device network dump 20 --include all
  Use this instead of logs path when the question is request/response metadata.
  network log is a supported alias, but network dump --include headers is the clearest plan form. Do not write network log headers.

Audio:
  Use audio probe when the question is whether a browser page, macOS session, iOS simulator, or Android emulator produced audible output during a short observation window.
    agent-device audio probe start 10 1000 --platform web
    agent-device audio probe status --platform web
    agent-device audio probe stop --platform web
    agent-device audio probe start 10 1000 --platform macos
    agent-device audio probe start 10 1000 --platform ios
    agent-device audio probe start 10 1000 --platform android
  audio probe start uses duration seconds first, then bucket milliseconds. Results are compact rmsDbfs and peakDbfs arrays so agents can correlate audible moments with screenshots, actions, network entries, or frame samples.
  On web, audio probe samples HTML media elements and URL-backed media may be routed through the probe AudioContext while observed.
  On macOS hosts, audio probe samples host system audio through ScreenCaptureKit for macOS sessions, iOS simulators, and Android emulators. It requires Screen Recording permission and is system-audio evidence, not app-instrumented audio. Physical iOS and Android devices are not supported.

Crash symbolication:
  Crash routing:
    Use logs when you need the lead-up timeline before a failure.
    Use debug symbols when you have crash.ips/crash.log plus a matching dSYM/build directory and need the failing frame.
    Use Xcode/LLDB when you need live state, breakpoints, variables, memory, or stepping.
  Use debug symbols when you already have an Apple crash artifact and local dSYMs and need the failing code path, not a full log dump:
    agent-device debug symbols --artifact crash.log --dsym MyApp.dSYM --out crash-symbolicated.log
    agent-device debug symbols --artifact crash.ips --search-path ./build --out crash-symbolicated.ips
  debug is intentionally narrow. Do not use it for logs, network/audio evidence, performance samples, recordings, traces, or React Native internals.
  Apple support matches crash Binary Images / IPS usedImages UUIDs against dwarfdump --uuid output from .dSYM bundles, then writes a symbolicated artifact path and compact crash report: app/thread, exception or termination, top symbolicated frames, and first-frame finding. This is better than pasting crash logs because it keeps agent context small while preserving the artifact on disk for inspection.
  Android Java/R8 mapping.txt and native ndk-stack/addr2line symbolication are not in this first debug symbols workflow; capture crash evidence with logs and use the Android toolchain externally for now.

Alerts:
  Native and platform dialogs:
    agent-device alert wait 3000
    agent-device alert accept
    agent-device alert dismiss
  Android support is snapshot-derived for runtime permission prompts and native app dialogs. iOS support is runner-derived for XCTest alerts, app-owned modal popups with native blocking markers, and blocking system dialogs. Use cheap alert get for an immediate check; use alert wait <short-ms> only when a prompt may appear after async work.
  If alert says no alert but a sheet is visibly on screen, treat it as app-owned UI:
    agent-device snapshot -i
    agent-device press 'label="Allow"'
  Do not use settings permission to answer a dialog already on screen. Reserve settings permission for setup/resetting permission state before a flow.

Diagnostics and traces:
  Use --debug for CLI/daemon diagnostic ids and log paths.
  Use AGENT_DEVICE_EXEC_TRACE=1 when you need host-tool spawn timing without full debug streaming; it flushes the full request diagnostics file on successful requests that spawn host tools.
  Open output includes Session state; JSON also includes runnerLogPath and requestLogPath.
  For open timing under --debug, run open --debug --json and inspect requestLogPath for the open_timing event.
  Session requests/<request-id>.ndjson holds daemon request diagnostics; session runner.log holds Apple runner/xcodebuild output.
  Against a remote daemon the Diagnostics Log path is always local: the failing request's record is fetched to <state-dir>/remote-diagnostics/, and if it cannot be fetched the line reads "unavailable" with the reason instead of a daemon-host path.
  daemon.log is global daemon lifecycle evidence, not the primary per-run log.
  Use trace for low-level session diagnostics around one repro:
    agent-device trace start ./traces/diagnostics.trace
    agent-device press 'id="load-diagnostics"'
    agent-device trace stop ./traces/diagnostics.trace
  The trace path is positional. Do not use --path for trace start or trace stop.
  Use perf xctrace only for Apple native CPU/profile or Animation Hitches artifacts:
    agent-device perf cpu profile start --kind xctrace --template "Time Profiler" --out ./artifacts/app.trace
    agent-device perf cpu profile stop --kind xctrace --out ./artifacts/app.trace
    agent-device perf cpu profile report --kind xctrace --out ./artifacts/app-profile.json
    agent-device perf trace start --kind xctrace --template "Animation Hitches" --out ./artifacts/hitches.trace
    agent-device perf trace stop --kind xctrace --out ./artifacts/hitches.trace
  perf xctrace keeps the .trace artifact on disk; CPU report returns a bounded weighted top-function summary. Do not dump .trace contents into context.
  For Android native CPU/trace evidence, use perf artifacts instead of raw adb/simpleperf/perfetto output:
    agent-device perf cpu profile start --kind simpleperf --out /tmp/cpu.perf.data
    agent-device perf cpu profile stop --kind simpleperf
    agent-device perf cpu profile report --kind simpleperf --out /tmp/cpu-report.json
    agent-device perf trace start --kind perfetto --out /tmp/app.perfetto-trace
    agent-device perf trace stop --kind perfetto
  Treat native perf output as the agent evidence: for example, state=stopped, outPath=/tmp/app.perfetto-trace, sizeBytes=5392410, method=adb-shell-perfetto. The 5.3 MB raw trace stays in the artifact.
  CPU reports return at most ten top functions in structured data and print five in default CLI output.
  Use explicit perf frames, perf memory, perf cpu, or perf trace forms. Aggregate perf was removed in 0.21: bare perf, perf sample, perf metrics, and metrics fail with exact replacements.
  Startup duration belongs to the open command's startup result; read it there.

Memory diagnostics:
  Use perf memory when the symptom is leak/growth/OOM suspicion and you need agent-readable evidence.
    agent-device perf memory sample --json
    agent-device perf memory snapshot --kind android-hprof --out ./artifacts/app.hprof
    agent-device perf memory snapshot --kind memgraph --out ./artifacts/app.memgraph
  Example sample shape:
    {"metrics":{"memory":{"available":true,"totalPssKb":562958,"totalRssKb":570304,"topConsumers":[{"name":"Dalvik Heap","pssKb":213456}]}}}
  Example default snapshot output:
    Memory artifact (android-hprof): /tmp/app.hprof (42MB)
  Prefer perf memory sample over raw dumpsys/leaks output for first-pass agent diagnosis: it keeps arrays bounded and returns only relevant memory evidence.
  Prefer perf memory snapshot over printing heap/memgraph data: snapshots return path, size, kind, method, and support metadata while the large artifact stays on disk for external inspection.
  Unsupported platforms return artifact.available=false with reason/hint; do not pretend a heap or memgraph was captured.

Stabilizers:
  Android animation-sensitive flows:
    agent-device settings animations off
    agent-device snapshot
    agent-device settings animations on
  Re-enable settings you changed before finishing.

Text-entry quirks:
  iOS Allow Paste cannot be exercised under XCUITest; prefill with clipboard write "some text" instead and test the system prompt manually.
  Android Gboard handwriting/stylus UI can capture text in an IME-owned input instead of the app field. If fill reports that input was captured by the keyboard/IME, use the diagnostic targetInput/actualInput details, inspect keyboard status/get if needed, and switch or disable handwriting outside the command plan before retrying. Do not keep retrying fill/type against the same field while the IME owns focus. If the exact target changes but app-owned formatting prevents raw equality, fill succeeds with verification: "unconfirmed" plus target-bound requested/before/after evidence; inspect that evidence instead of retrying the same mutation.

React Native internals:
  If the question is about React Native performance, profiling, props, state, hooks, render causes, slow components, or rerenders, use help react-devtools instead of inferring from screenshots or logs.`,
  },
  'react-devtools': {
    summary: 'React Native performance, profiling, and component internals',
    body: `agent-device help react-devtools

Use this for React Native performance/profiling and internals that the accessibility tree cannot expose: components, props, state, hooks, ownership, slow renders, and rerenders.

Core commands:
  agent-device react-devtools status
  agent-device react-devtools start
  agent-device react-devtools stop
  agent-device react-devtools wait --connected
  agent-device react-devtools wait --component <ComponentName>
  agent-device react-devtools count
  agent-device react-devtools get tree --depth 3
  agent-device react-devtools find <ComponentName>
  agent-device react-devtools find <ComponentName> --exact
  agent-device react-devtools get component @c5
  agent-device react-devtools errors
  agent-device react-devtools profile start
  agent-device react-devtools profile stop
  agent-device react-devtools profile slow --limit 5
  agent-device react-devtools profile rerenders --limit 5
  agent-device react-devtools profile report @c5
  agent-device react-devtools profile timeline --limit 20
  agent-device react-devtools profile export profile.json
  agent-device react-devtools profile diff before.json after.json --limit 10

Profiling loop:
  1. Run agent-device react-devtools status first. Use start only if status reports the React DevTools helper is not running; start is not a connection check.
  2. Always run agent-device react-devtools wait --connected after status and before profiling so the app, not just the helper, is attached.
  3. If correlating with logs or network, run logs clear --restart before the first logs mark.
  4. Start profiling immediately before the interaction.
  5. Drive the interaction with normal agent-device commands and mark before/after the repro when timing matters.
  6. Stop profiling.
  7. Make one bounded first-pass survey: profile stop for the summary, profile slow --limit 5 once, profile rerenders --limit 5 once, and profile timeline --limit 20 only when commit timing matters.
  8. Use profile report @cN for targeted render causes and changed props/state/hooks; use get component @cN for current props/state/hooks.

Rules:
  Every React DevTools command is an agent-device subcommand: agent-device react-devtools ...
  Do not write agent-devtools, agent-react-devtools, or bare react-devtools commands in final command plans. Every profiling and survey line must begin with agent-device react-devtools.
  Start with get tree --depth 3 or find <name>; use find --exact when fuzzy results are noisy.
  @c refs reset after reload/remount. After reload, wait --connected and inspect again.
  Keep the profile window narrow; unrelated navigation makes render data noisy.
  Do not repeatedly raise broad profile slow limits such as --limit 50, --limit 200, or --limit 500. Drill into a specific @c ref with profile report unless you have a specific target that needs more rows.
  For network evidence, use agent-device network dump --include headers; headers is not a positional argument.
  For cross-platform validation with explicit device selectors, use separate sessions/devices and restart react-devtools between platforms.
  Remote Android and iOS bridge runs normally through agent-device react-devtools; the CLI keeps the needed local service tunnel alive until agent-device react-devtools stop or disconnect. Expo support depends on the SDK's bundled React Native runtime.
  Remote iOS apps attempt the legacy React DevTools websocket during JavaScript startup. If the app was already open before react-devtools start, run open <bundle-id> --platform ios --relaunch, then wait --connected.

Example:
  agent-device react-devtools status
  agent-device react-devtools wait --connected
  agent-device logs clear --restart
  agent-device logs mark "before catalog search"
  agent-device react-devtools profile start
  agent-device fill 'id="catalog-search"' "tart" --delay-ms 80
  agent-device logs mark "after catalog search"
  agent-device react-devtools profile stop
  agent-device react-devtools profile slow --limit 5
  agent-device react-devtools profile rerenders --limit 5
  agent-device react-devtools profile timeline --limit 20
  agent-device react-devtools profile report @c5
  agent-device network dump --include headers

Use snapshot, screenshot, logs, network, perf frames, and perf memory for device/app runtime evidence. Use react-devtools when component internals or React rendering behavior matters.`,
  },
  cdp: {
    summary: 'React Native CDP targets, JS heap snapshots, and leak triage',
    body: `agent-device help cdp

Use this when a React Native or Expo app exposes a CDP target through Metro and
the task needs JavaScript heap growth checks, heap snapshot diffs, allocation
hotspots, retained-object leak evidence, or a small runtime eval to confirm JS
state. Do not use this as the default React Native profiler.

Setup:
  Start Metro and open the app first. For Android devices/emulators, make sure Metro is reachable from the app, typically with adb reverse tcp:8081 tcp:8081.
  In remote bridge sessions, omit --url for target list/select after connect; agent-device derives the Metro CDP URL from the prepared remote runtime.
  agent-device cdp target list --url http://127.0.0.1:8081
  agent-device cdp target select <target-id>

Quick JS heap signal:
  agent-device cdp memory usage sample --label baseline --gc
  # perform the suspected leaking action with agent-device commands
  agent-device cdp memory usage sample --label after-action --gc
  agent-device cdp memory usage diff --base jm_1 --compare jm_2
  agent-device cdp memory usage leak-signal --since jm_1

Retained-object proof:
  agent-device cdp memory snapshot capture --name baseline --gc
  # perform the suspected leaking action
  agent-device cdp memory snapshot capture --name after-action --gc
  # perform cleanup/navigation that should release the objects
  agent-device cdp memory snapshot capture --name cleanup --gc
  agent-device cdp memory snapshot diff --base ms_1 --compare ms_2 --limit 10
  agent-device cdp memory snapshot leak-triplet --baseline ms_1 --action ms_2 --cleanup ms_3 --limit 10
  agent-device cdp memory snapshot retainers --snapshot ms_3 --id <node-id> --depth 8 --limit 10

Allocation pressure:
  Use allocation sampling to find where allocations were created, not to prove a leak:
    agent-device cdp memory allocation start --name suspected-flow --interval 32768 --stack-depth 32
    # perform the flow once
    agent-device cdp memory allocation stop
    agent-device cdp memory allocation hotspots --limit 10
    agent-device cdp memory allocation source-maps

Recommended subset:
  cdp dynamically runs a pinned CDP helper through npm; the first run may download the pinned package, and later runs can reuse the npm cache.
  Every argument after cdp is passed to the CDP helper. Put agent-device global flags before cdp when you need the outer CLI to consume them.
  Use cdp memory usage, memory snapshot, memory allocation, and targeted runtime eval.
  Avoid cdp profile cpu, trace, network, and console by default because agent-device already has perf cpu, trace, network, logs, and react-devtools guidance for those areas.

Output contract:
  Until cdp has a compact leak report command, synthesize one from memory usage diff, snapshot diff, leak-triplet, and retainers. Report heap deltas, top retained classes/shapes, leak-triplet rows that stayed high after cleanup, and the shortest useful retaining paths. Do not paste raw heap snapshots or large allocation profiles into the response; use exported artifacts only when the user asks for raw data.

Target caveats:
  React Native/Hermes implements a subset of browser CDP. If a command reports an unsupported method, keep the target selected and switch to heap usage samples plus heap snapshots. Prefer react-devtools for component tree/render causes; prefer perf memory sample or perf memory snapshot for native/process memory.`,
  },
  'react-native': {
    summary: 'React Native app automation hazards and routing',
    body: `agent-device help react-native

Use this when the target app is React Native, Expo, or a React Native dev client.
This topic covers React Native-specific automation hazards and routes deeper
questions to the owning help topic.

Choose the next help topic:
  Routine QA/dogfood/manual-test flow (open, snapshot -i, press/fill --settle, verify, close): help manual-qa; it has the concrete command shapes, so you should not need generic navigation help for a normal pass.
  Deep exploration of navigation/selector/ref edge cases, or a serial-command question manual-qa does not answer: help workflow (full reference, larger read).
  Logs, network, diagnostics, traces, permission dialogs, or runtime failures: help debugging.
  Component tree, props/state/hooks, slow renders, rerenders, or render causes: help react-devtools.
  JS heap growth, heap snapshots, allocation hotspots, or retained-object leaks: help cdp.
  Remote/cloud config, leases, and local service tunnels: help remote.

React Native dev loop:
  Do not run doctor as routine QA/dogfood prep. Use doctor only when the user asks for setup diagnostics or a command failure points to an unhealthy device, runner, dev-server, or remote environment.
  For "start from screen X" flows, prefer open --relaunch before the first snapshot so the app does not reuse a prior in-progress navigation state.
  JS-only change with Metro or Re.Pack connected:
    agent-device metro reload
    agent-device find "Home"
  Do not use agent-device reload. Use open --relaunch for native startup reset.
  Android RN/Expo/Re.Pack dev server: direct Android localhost URL opens with a port auto-configure host reachability. For app/package launches, run metro prepare when the app cannot reach the local dev server.
  Verify Metro/Re.Pack from the same host context that owns the dev server. If a sandboxed shell cannot curl localhost:8081/status but an unrestricted host shell can, the dev server is running and the sandbox probe is not authoritative.
  adb reverse only affects Android device-to-host traffic. It does not prove host-to-dev-server reachability, and it does not fix a redbox caused by a stale or wrong bundle/app state.
  Multiple local worktrees can reuse one native iOS simulator build by running each worktree's dev server on a different port and opening the same installed app on different simulators with explicit runtime hints:
    agent-device open "React Navigation Example" --platform ios --device "iPhone 17" --session rn-a --metro-host 127.0.0.1 --metro-port 8081 --relaunch
    agent-device open "React Navigation Example" --platform ios --device "iPhone 17 Pro" --session rn-b --metro-host 127.0.0.1 --metro-port 8082 --relaunch
  iOS simulator opens write React Native's per-simulator debug server settings before launch, so those ports do not conflict across simulators. Use separate sessions/devices, close both sessions when done, and rebuild only for native changes or dependency changes that affect the binary. One simulator cannot run two copies of the same bundle id.
  Expo Go/dev clients are host shells. Use provided project URLs, verify with snapshot -i after opening, and ask instead of inventing app ids or URLs. Help workflow owns the full Expo URL command shapes.

Overlays and busy RN UIs:
  If snapshot reports a React Native warning/error overlay, handle it before interacting with the app: run agent-device react-native dismiss-overlay. The command sends the safe LogBox/RedBox action and verifies the overlay is gone with a fresh post-dismiss snapshot -i.
  If the command reports the overlay is still visible, use screenshot --overlay-refs for visual evidence and report the overlay instead of pressing warning/error text manually.
  Do not manually press warning/error text bodies, collapsed banner bodies, full-screen warning parents, or broad LogBox/RedBox refs. The dismiss-overlay command owns the narrow LogBox/RedBox targeting policy.
  Report the overlay in the final summary. Use screenshot --overlay-refs before dismissing only if visual evidence is required.
  Minimal overlay continuation:
    agent-device snapshot -i
    agent-device react-native dismiss-overlay
    agent-device snapshot -i
    agent-device press 'id="submit-order"'
  Do not use a plain snapshot after dismiss-overlay when the next step needs current refs; use snapshot -i.
  When overlay evidence and React diagnostics are required before continuing, keep the sequence explicit:
    agent-device snapshot -i
    agent-device screenshot --overlay-refs
    agent-device react-devtools errors
    agent-device react-native dismiss-overlay
    agent-device snapshot -i
    agent-device press 'id="submit-order"'
  If snapshot times out because the UI never becomes idle, Android accessibility may be blocked by busy or continuously changing app UI. After that timeout, use screenshot as visual truth instead of repeatedly retrying snapshots.
  If iOS snapshot reports AX unavailable or returns only a sparse root, the current screen's accessibility state is invalid. Use plain screenshot as visual truth, coordinate navigation to leave the bad screen, then take a fresh snapshot -i before returning to selector/@ref commands.
    agent-device screenshot
    agent-device press 124 817
    agent-device snapshot -i
  Android runtime permission dialogs and native alerts are handled by alert wait/accept/dismiss. If alert reports no alert, treat the visible surface as app-owned UI and use snapshot -i plus press by label/ref.

React DevTools routing:
  Keep the agent-device react-devtools prefix on every React DevTools command.
  Use help react-devtools for status/wait, component trees, props/state/hooks, profile windows, slow renders, rerenders, and remote bridge rules.
  If React DevTools cannot connect, report status and continue with logs, network, perf frames, perf memory, screenshot, and trace evidence instead of blocking the whole flow.

CDP memory routing:
  Keep the agent-device cdp prefix on every CDP command.
  Use help cdp for JS heap usage samples, heap snapshots, snapshot diffs, leak-triplet analysis, allocation hotspots, and retained-object paths.
  Use perf memory sample or perf memory snapshot for native/process memory; use cdp only for JavaScript heap evidence.

Slow-flow investigation:
  Keep one session, open the app first, and snapshot -i before interacting.
  Start React Native slow-flow plans with this ordered scaffold:
    agent-device open "Agent Device Tester" --platform android
    agent-device snapshot -i
    agent-device react-devtools status
    agent-device react-devtools wait --connected
  If the task says to open the app, include the open command even when it also describes the current screen.
  Use help react-devtools for the narrow React profile window. Profiling plans need both status and wait --connected before profile start.
  Check status before wait/profile. Do not substitute react-devtools start for status; start launches the helper, while status reports connection state.
  Use help debugging for logs clear --restart, logs mark, network dump --include headers, perf frames, perf memory, native profiles, traces, and runtime failure evidence.
  For 15-20s async work, use wait with the exact expected text or selector instead of repeated snapshots.
  Report React render offenders separately from network/backend waits and device frame/CPU/memory findings.`,
  },
  'physical-device': {
    summary: 'Connected phone/tablet setup and iOS signing prerequisites',
    body: `agent-device help physical-device

Use this when the target is connected hardware instead of a simulator/emulator.
For simulator/emulator flows, use help manual-qa for routine QA or help workflow for the full reference.

Discovery:
  agent-device devices --platform ios
  agent-device devices --platform android
  With multiple devices present, select one: --device <name>, or --udid <udid> (iOS) / --serial <serial> (Android) when names collide.

iOS physical-device prerequisites:
  Xcode, xcrun xcdevice, and xcrun xctrace must be available from the selected Xcode.
  The device must be paired/trusted, connected, unlocked when needed, and have Developer Mode enabled.
  Modern devices visible to devicectl use CoreDevice. Older devices visible only to xctrace use the XCTest backend automatically.
  XCTest-backed devices must already have the target app installed and should be opened by bundle ID; app inventory, install/reinstall, logs, performance sampling, recording, deep links, and launch arguments require CoreDevice.
  XCTest-backed runner commands travel through macOS usbmuxd; keep the trusted device connected by cable.
  The AgentDeviceRunner XCTest host must be signed before commands can run on a physical device.
  Start with Automatic Signing and only these env vars:
    AGENT_DEVICE_IOS_TEAM_ID=ABCDE12345
    AGENT_DEVICE_IOS_BUNDLE_ID=com.yourname.agentdevice.runner
  Find team ids and Apple Development signing certificates with:
    security find-identity -v -p codesigning
  If Xcode cannot choose a profile, set AGENT_DEVICE_IOS_PROVISIONING_PROFILE to the profile name/specifier, not a file path.
  AGENT_DEVICE_IOS_SIGNING_IDENTITY is optional; omit it unless xcodebuild asks for a specific identity.
  The profile/team must allow AGENT_DEVICE_IOS_BUNDLE_ID and <id>.uitests.
  First-run XCTest setup/build can take longer than normal commands; keep the device connected and use --debug to inspect signing/build diagnostics if setup times out.

Android physical-device prerequisites:
  Enable USB debugging and confirm the device appears in agent-device devices --platform android.
  Android does not need the iOS runner signing setup. For React Native/Expo Metro reachability, read help react-native.

Runner and daemon lifecycle (applies to simulators too):
  open without --relaunch is idempotent-foreground for an already-running app (it brings the process forward; it does not restart it). open --relaunch restarts the app; on iOS simulators this collapses to one simctl launch --terminate-running-process call instead of a separate terminate-then-launch.
  close keeps a healthy iOS simulator XCTest runner warm by default so the next open on that device skips the runner build, unless --shutdown was requested, the session was recording, the session held a device lease, or the device used a scoped (non-default) simulator set. A retained runner auto-stops after an idle window (default 5 minutes); set AGENT_DEVICE_IOS_RUNNER_IDLE_STOP_MS to override, or 0 to disable idle stop and retain until daemon exit.
  Each AGENT_DEVICE_STATE_DIR runs its own daemon. It self-exits after an idle window (default 5 minutes, matching the runner idle-stop default) once it has no open sessions, no in-flight requests, and no active recording; set AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS to override, or 0 to disable idle reap.
  A stale iOS runner lease — its owner process dead, or its AGENT_DEVICE_STATE_DIR deleted — is reclaimed automatically instead of failing with "is already owned by another agent-device daemon"; a genuinely live owner whose state dir still exists still rejects with that error.

For iOS SpringBoard, widget, or other system-UI surfaces, read agent-device help ios-system-ui.`,
  },
  'ios-system-ui': {
    summary: 'iOS SpringBoard, widget, and system-surface workflow',
    body: `agent-device help ios-system-ui

Use this when a task needs iOS SpringBoard (home screen), widget add/edit/remove, or other system-UI surfaces instead of the app under test.

This works today by opening SpringBoard as the session app; there is no separate widget/system command. System labels vary by iOS version and locale, so discover them from the current snapshot instead of relying on the literal strings shown below. This workflow is verified on iOS simulator; physical-iPhone SpringBoard support is not yet verified.

Core loop:
  1. Reach the app state you want to prepare (for example, arrange the widget/Live Activity data the app should show) with normal app automation, then agent-device open com.apple.springboard --platform ios. From an existing app session, agent-device home first also lands on the home screen, but open com.apple.springboard is what actually binds the session to SpringBoard for selector-driven commands.
  2. agent-device snapshot -i to read the current localized SpringBoard controls.
  3. agent-device longpress <x> <y> on an empty area of the home screen to enter edit mode. This is the one deliberate coordinate step; there is no reliable non-coordinate way to trigger it.
  4. Re-snapshot and use selectors from the fresh tree to drive the Edit menu -> widget gallery -> search -> size picker -> Add Widget, for example:
    agent-device snapshot -i
    agent-device press 'label="Add Widget"'
    agent-device fill 'label="Search"' "Calendar"
  5. The widget-gallery search-result rows currently fall back to unlabeled nodes (a known capture gap), so tap the result by coordinates read from a screenshot until that is fixed:
    agent-device screenshot
    agent-device press <x> <y>
  6. Continue with the semantic size picker and agent-device press 'label="Add Widget"' to place it.
  7. To edit or remove an installed widget, longpress it, then re-snapshot and use the fresh context-menu selectors (Edit Widget / Remove Widget).
  8. Use screenshots for visual assertions, and as the fallback wherever a system surface exposes sparse accessibility, not only in the gallery step.
  9. Reopen the app bundle under test (agent-device open <app-id> --platform ios) to return to normal app automation; leaving SpringBoard bound does not resume the app session on its own.

Rules:
  Do not hard-code Edit/Done/Add Widget or other SpringBoard label text into a plan as a fixed assumption; take them from the latest snapshot -i so the plan survives iOS version/locale differences.
  A real system permission alert can appear mid-flow; it composes with this workflow normally, so handle it with alert wait/accept/dismiss or by pressing the visible label like any other step.
  Prefer refs/selectors from the fresh snapshot for every step except the two documented coordinate fallbacks (empty-space long-press to enter edit mode, and the gallery search-result tap).
  This topic covers what already works by opening SpringBoard as the session app. It does not yet cover keeping an app session open while alternating individual commands against SpringBoard, or Live Activity/Dynamic Island semantics; those land separately.`,
  },
  remote: {
    summary: 'Direct proxy, cloud profiles, and remote config',
    body: `agent-device help remote

Remote connection providers use the same lifecycle:
  connect -> install/open -> commands -> close -> disconnect

Providers:
  Cloud: agent-device connect or agent-device connect cloud discovers the agent-device cloud profile.
  Remote config: agent-device connect --remote-config ./remote-config.json uses a local profile.
  Direct proxy: agent-device connect proxy --daemon-base-url <proxy-agent-device-url> stores the shared proxy profile and client identity.
  BrowserStack: agent-device connect browserstack verifies credentials, the exact device, and a bs:// app reference, then stores a local provider profile. It does not create an App Automate session.
  AWS Device Farm: agent-device connect aws-device-farm verifies credentials and the exact project, device, and optional app upload, then stores a local provider profile. It does not create a remote access session.
  Limrun: agent-device connect limrun verifies access to the selected iOS or Android instance service, then stores a local provider profile. It does not create an instance.

After direct-provider connect:
  Read the printed Device, App, Next, and workflow-note lines. They are also available as verification/device/app/liveSession/nextSteps/notes in --json output.
  BrowserStack and AWS Device Farm create the hosted session on open. open needs the installed package or bundle identifier, not the app artifact name or ARN.
  A new Limrun instance has no user app. Run install <package-or-bundle-id> <app-path-or-url> first; install allocates the instance, then open launches the installed id.
  AWS Device Farm cannot install after allocation. If connect reports no attached app, run its printed reconnect command, which includes --session <name> --force, before open.
  Do not run devices or apps as a pre-open catalog probe for direct providers; those commands can allocate the deferred provider session and only inspect that live device.

Device cloud interfaces:
  CLI is the canonical bootstrap path: connect limrun/browserstack/aws-device-farm, then use normal open/snapshot/click/close/artifacts/disconnect commands.
  JavaScript can skip persisted connect state by passing leaseProvider plus provider fields to createAgentDeviceClient or per-command options.
  MCP exposes operational tools such as open, snapshot, click, close, and artifacts. It does not expose connect/disconnect; run CLI connect first in the same state dir before relying on MCP tools.

Direct proxy flow for a remote Mac/simulator:
  On the Mac with simulator/device access:
    agent-device proxy --port 4310
    cloudflared tunnel --url http://127.0.0.1:4310
  On the remote client:
    agent-device connect proxy --daemon-base-url https://example.trycloudflare.com/agent-device --daemon-auth-token <token>
    agent-device devices --platform ios
    agent-device open Maps --platform ios --device "iPhone 17 Pro"
    agent-device snapshot -i --platform ios --device "iPhone 17 Pro"
    agent-device artifacts --json
    agent-device close
    agent-device disconnect

Cloud profile flow:
  agent-device connect
  agent-device open com.example.app
  agent-device snapshot
  agent-device disconnect

BrowserStack hosted-device flow:
  BROWSERSTACK_USERNAME=... BROWSERSTACK_ACCESS_KEY=...
  agent-device connect browserstack --platform android --device "Google Pixel 8" --provider-os-version 14.0 --provider-app bs://app-id
  agent-device open com.example.app
  agent-device snapshot -i
  agent-device close
  agent-device artifacts --json
  agent-device disconnect

AWS Device Farm hosted-device flow:
  AWS_REGION=us-west-2 AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... AWS_SESSION_TOKEN=...
  agent-device connect aws-device-farm --platform android --aws-project-arn <arn> --aws-device-arn <arn> --aws-app-arn <arn>
  agent-device open com.example.app
  agent-device snapshot -i
  agent-device close
  agent-device artifacts --json
  agent-device disconnect
  AWS Device Farm currently supports Android and iOS WebDriver sessions only; Vega OS and Vega Fire TV ARNs are not routed.

Limrun direct-device flow:
  LIMRUN_API_KEY=...
  agent-device connect limrun --platform android

  Limrun creates remote iOS simulators and Android emulators only. Do not pass local device selectors such as --udid, --serial, or --device.
  agent-device open com.example.app
  agent-device snapshot -i
  agent-device close
  agent-device disconnect

Local profile flow:
  agent-device connect --remote-config ./remote-config.json
  agent-device open com.example.app
  agent-device snapshot
  agent-device disconnect

Script flow, per-command config:
  agent-device open com.example.app --remote-config ./remote-config.json
  agent-device snapshot --remote-config ./remote-config.json
  agent-device disconnect --remote-config ./remote-config.json

Rules:
  connect and disconnect are top-level commands. Do not write agent-device remote connect or agent-device remote disconnect.
  Use connect without --remote-config when the cloud control plane owns the connection profile.
  Prefer connect --remote-config over --daemon-base-url, --tenant, --run-id, and --lease-id when using a local profile.
  Use agent-device proxy for direct tunnel access to a Mac you control. Expose the printed proxy URL through cloudflared/ngrok, then run agent-device connect proxy with the tunnel URL and printed token before normal commands.
  Use Limrun, BrowserStack, and AWS Device Farm through local provider profiles; they do not accept a remote agent-device daemon URL.
  Device cloud credentials must be available before the command starts. Limrun uses LIMRUN_API_KEY. BrowserStack uses BROWSERSTACK_USERNAME and BROWSERSTACK_ACCESS_KEY. AWS Device Farm uses the AWS CLI credential chain, including CI-provided AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY/AWS_SESSION_TOKEN, AWS profiles, or web identity role variables.
  Direct-provider connect performs read-only provider calls and saves active connection state only after verification succeeds. It never creates a device, instance, App Automate session, or AWS remote access session.
  connect without --session always creates a fresh remote session and prints that session in its next-step commands. Concurrent callers must pass the returned --session on every command; the ambient active connection is only a single-workflow convenience.
  To replace an existing connection, pass its returned session explicitly with --session <name> --force. --force without --session creates another fresh session and does not release or overwrite an unrelated active connection.
  Prefer short-lived AWS role credentials in CI. Generated connection profiles store app/device selectors and ARNs, not Limrun API keys, BrowserStack access keys, or AWS credentials.
  Limrun Android supports direct ADB port reverse for local Metro. Limrun iOS requires a public Metro/React DevTools URL because it cannot reach local host ports directly.
  After closing a device cloud session, run agent-device artifacts --json to retrieve provider video/log/dashboard URLs when the provider has made them available.
  connect proxy stores the connection profile and client identity. Proxy device leases are acquired on open and expire after five minutes without commands; devices may inspect proxy inventory without allocating.
  Multiple agents can share one proxy when each uses connect proxy, open, commands, close, and disconnect.
  disconnect releases local connection state; close releases the active session and device lease.
  A busy direct-proxy device error means another agent owns the device until it closes or its inactivity lease expires.
  Keep the proxy token secret. Anyone with the token can control the proxied daemon.
  If local/proxy iOS reports that the runner is already owned by another agent-device daemon after lease admission, retry after the owning session closes or after lease expiry. If the conflict repeats, clean stale daemon state on the machine with simulator access.
  Do not use --config as a remote profile flag. --config loads CLI defaults; --remote-config selects remote daemon/profile settings.
  For self-contained scripts, pass the same --remote-config to every operational command, including disconnect; a preceding connect is optional but not required.
  For remote artifact installs, use install-from-source <url> or install-from-source --github-actions-artifact org/repo:artifact; do not download CI artifacts locally first.
  After connect, let the active remote connection supply runtime hints.
  For connected phone/tablet setup and iOS signing prerequisites, read agent-device help physical-device.
  For remote Android and iOS bridge React DevTools, run agent-device react-devtools normally. The CLI opens the needed local service tunnel for the DevTools daemon and keeps it alive until agent-device react-devtools stop or disconnect.
  Use --debug when remote connection or transport errors need diagnostic ids and remote log hints.`,
  },
  macos: {
    summary: 'macOS desktop, frontmost-app, and menu bar surfaces',
    body: `agent-device help macos

Use macOS only when the task targets desktop apps, desktop surfaces, or menu bar extras.

Open and inspect:
  agent-device open TextEdit --platform macos
  agent-device snapshot -i --platform macos

Surfaces:
  --surface is an open flag; the session keeps it, so later commands do not repeat it.
  --surface app            normal app session
  --surface frontmost-app  inspect whichever app is frontmost
  --surface desktop        desktop-wide surface
  --surface menubar        menu bar extras and menu bar-only apps

Menu bar app example:
  agent-device open "Agent Device Tester Menu" --platform macos --surface menubar
  agent-device snapshot -i --platform macos

Context menu example:
  agent-device click @e66 --button secondary --platform macos
  agent-device snapshot -i --platform macos

Rules:
  Use open and snapshot -i for menu bar inspection. Do not output inspect as a command.
  Context menus are not ambient UI: secondary-click a visible target, then re-snapshot and use the new menu-item refs.
  Do not let iOS simulator-set scoping hide macOS desktop targets.
  Prefer refs/selectors over raw coordinates.
  macOS snapshot rects are window-space; use current refs or overlay refs instead of guessing coordinates.`,
  },
  web: {
    summary: 'Minimal browser workflow with the managed web backend',
    body: `agent-device help web

Use --platform web only for the minimal browser command loop exposed through agent-device.

Dependency:
  Browser mechanics come from a managed, pinned agent-browser backend. agent-device owns command/session/replay integration, selectors/refs at the command surface, and artifact routing; agent-browser owns browser launch, page control, screenshots, and browser-specific behavior.
  Use --platform web when a browser step belongs inside an agent-device session, replay, batch, MCP, or typed-client flow. Use agent-browser directly for standalone web automation.
  Before first use, set up and verify the managed backend:
    agent-device web setup
    agent-device web doctor
  Web automation requires Node 24+.

Planning rule:
  For web command plans, output only agent-device command lines. Do not add prose, numbering, Markdown fences, shell pipes, or agent-browser commands unless the task is explicitly standalone browser automation outside agent-device.

First-slice loop:
  Audio probe start uses duration seconds first, then bucket milliseconds.
  agent-device web setup
  agent-device web doctor
  agent-device open https://example.com --platform web
  agent-device snapshot -i --platform web
  agent-device get text @e2 --platform web
  agent-device is visible 'label="Welcome"' --platform web
  agent-device find text "Welcome" exists --platform web
  agent-device click @e12 --platform web
  agent-device hover @e14 --settle --platform web
  agent-device fill @e13 "qa@example.com" --platform web
  agent-device wait text "Welcome" 3000 --platform web
  agent-device record start ./artifacts/web-flow.webm --platform web
  agent-device network dump 25 --include headers --platform web
  agent-device audio probe start 10 1000 --platform web
  agent-device screenshot ./artifacts/web-home.png --platform web
  agent-device screenshot ./artifacts/web-full.png --platform web --fullscreen
  agent-device viewport 1280 900 --platform web
  agent-device record stop --platform web
  agent-device close --platform web

Supported in agent-device web sessions:
  open <url>, snapshot -i, get text/attrs, is visible/exists/text, find text/selector, click/press @ref or selector, hover @ref or selector, fill/type @ref or selector, wait text/selector, network dump, audio probe, screenshot, record start/stop with WebM output, close, and replay scripts made from those commands.
  hover moves the pointer without pressing so hover-gated UI (row toolbars, menus) appears; use --settle to read what it revealed, then act on the fresh refs. hover @ref hovers the browser element handle directly; pair --settle with a selector or coordinates (web refs carry no geometry, as with click @ref --settle). Web only: touch platforms have no hover state, so hover-gated flows there need a different entry point.

Out of scope for agent-device web support:
  Browser runtime debugging, tabs/windows/devtools control, network routing/interception/HAR, storage/cookie management, arbitrary page scripting, downloads/uploads, multi-page orchestration, and agent-browser-specific diagnostics. Use agent-browser directly for those browser-specific workflows.

Rules:
  Do not claim web e2e CI exists unless a project workflow explicitly provides it.
  Do not use native mobile or desktop setup commands such as boot, apps, install, settings, alert, keyboard, perf, logs, or react-devtools for --platform web.
  Keep browser plans session-scoped: open a URL, inspect refs, act on refs/selectors, verify with wait/get/is/snapshot, capture screenshot only when visual evidence is needed, then close.`,
  },
  dogfood: {
    summary: 'Exploratory QA workflow with reproducible evidence',
    body: `agent-device help dogfood

Use this when asked to dogfood, exploratory test, bug hunt, QA, or find issues in an app.

Goal:
  Find user-visible issues from runtime behavior. Do not read app source or invent findings from code.
  Produce a concise report with severity, repro commands, expected/actual behavior, and evidence paths.

Loop:
  1. Identify target app/platform; ask only if missing.
  2. Create output dirs and open the app. If auth or OTP is required, sign in or ask the user for the code.
  3. Capture baseline snapshot -i and screenshot.
  4. Map top-level navigation, then exercise primary flows and edge states.
  5. For each issue, capture evidence and write the finding immediately, then continue.
  6. Close the session and reconcile the report summary.
  Keep stateful commands serial within the same session. Parallel runs can pollute text fields, focus, alerts, and navigation state.

Coverage:
  Navigation, forms, empty/error/loading states, offline or retry behavior, permissions, settings, accessibility labels, orientation/keyboard, and obvious performance stalls.
  React Native warning/error overlays can be real findings or test blockers. Capture them, use react-native dismiss-overlay if unrelated, re-snapshot, and report them.
  Expo Go/dev-client shells: use the provided exp:// or dev-client URL and record whether the shell, project load, or app UI is being tested. On iOS dogfood, prefer agent-device open "Expo Go" <url> when Expo Go is the known shell, then snapshot -i to confirm the project UI rather than the runner splash.
  Android RN/Expo/Re.Pack dev server: direct Android localhost URL opens with a port auto-configure host reachability.
  Categories: visual, functional, UX, content, performance, diagnostics, permissions, accessibility.
  Severity: critical blocks a core flow/data/crashes; high breaks a major feature; medium has friction or workaround; low is polish.

Evidence commands:
  mkdir -p ./dogfood-output/screenshots ./dogfood-output/videos ./dogfood-output/traces
  agent-device open <app> --platform ios
  agent-device snapshot -i
  agent-device screenshot ./dogfood-output/screenshots/initial.png
  agent-device screenshot ./dogfood-output/screenshots/issue-001.png --overlay-refs
  agent-device logs clear --restart
  agent-device logs mark "issue-001 repro"
  agent-device logs path
  agent-device record start ./dogfood-output/videos/issue-001.mp4
  agent-device record start ./dogfood-output/videos/benchmark.mp4 --hide-touches
  agent-device record stop
  agent-device close

Evidence rules:
  Interactive/behavioral issues need step screenshots and usually a repro video.
  Static/on-load issues can use one screenshot; set repro video to N/A.
  Use screenshot --overlay-refs when showing the tappable target or broken state helps repro.

Report shape:
  ./dogfood-output/report.md
  Include date, platform, target app, session, scope, severity counts, and issues.
  For each finding: ID, severity, category, title, affected flow/screen, repro commands, expected, actual, evidence files, notes.
  Target 5-10 well-evidenced issues when available. If no issues are found, report coverage completed and residual risk instead of claiming the app is bug-free.

Rules:
  Findings must come from observed runtime behavior, not source reads.
  After each mutation, use the --settle diff as evidence when available; otherwise re-snapshot.
  Wait timeouts are integer milliseconds in the trailing positional: agent-device wait 'role=tab' 10000. Do not write duration suffixes such as 10s.
  scroll takes a selector-less direction+amount form: agent-device scroll down 3. Use --settle to wait for the UI to go quiet and get the settled diff.
  Keep commands in the report reproducible; use selectors or refs from fresh snapshots, not guessed coordinates.
  Prefer refs for exploration and selectors for deterministic replay.
  Use logs, network, screenshot --overlay-refs, trace, perf frames, perf memory, native profiles, or react-devtools only when they add evidence to a specific issue.
  Never delete screenshots, videos, traces, or report artifacts during a session.
  Escalate to help debugging or help react-devtools when runtime symptoms require those tools.`,
  },
  validate: {
    summary: 'Engineering self-validation with device evidence and cleanup',
    body: `agent-device help validate

Use this when validating a code change, release candidate, performance fix, visual behavior, logging path, replay, or device-facing regression.

Contract:
  Prove the changed behavior through public agent-device surfaces. Do not validate against stale dist output, a retained stale daemon, or a runner built before the change.
  Keep evidence reproducible: exact commands, target device/app, observed output, artifact paths, and cleanup status.

Required freshness gate before device verification:
  For a TypeScript runtime or CLI output change, start with pnpm build. For non-Android device verification, run pnpm clean:daemon next.
  Before local Android verification, run pnpm build:android before pnpm clean:daemon so the bundled helpers match current source.
  For an Apple runner change, run pnpm build:xcuitest and avoid inherited retained runners from older source. Do not build the Apple runner for TypeScript-only changes.
  Use open --relaunch when startup state matters. Use a purpose-specific --session for multi-step validation.
  CI may cache ~/.agent-device/apple-runner/derived with an exact key that includes the agent-device package and Xcode version. Avoid broad restore-key fallbacks; prepare ios-runner already recovers bad restored runner artifacts and one retryable non-connecting runner launch.

Loop:
  1. Build or prepare the changed surface with the repo command that owns it.
  2. Open the target app/device state explicitly.
  3. Use snapshot -i and press/fill/click/longpress --settle for UI-driving steps.
  4. Use the settled diff as evidence when it shows the changed behavior; otherwise verify with wait/get/is/find, screenshot, logs, network, perf, or trace based on the claim.
  5. Record timings, token/output size, screenshots/videos, logs, or perf artifacts only when they answer the validation question.
  6. Close sessions and release leases before finishing.

Evidence:
  CLI/runtime freshness: pnpm build, pnpm clean:daemon, then agent-device --version or the command under test.
  Apple runner freshness: pnpm build:xcuitest, then a live agent-device command on the target simulator/device.
  Visual claim: screenshot, optionally screenshot --overlay-refs when target mapping matters.
  Runtime/logging claim: logs clear --restart, logs mark, reproduce, logs path.
  Network claim: network dump --include headers when headers are relevant.
  Performance claim: perf frames, perf memory sample, native profile reports, or trace artifacts with bounded output.
  Replay/regression claim: replay or test through the public command path.

Report:
  Summarize what changed, exact validation commands, pass/fail observations, artifact paths, and residual risk.
  If live validation is blocked, state the blocker, device/session, and exact next command needed.`,
  },
} as const satisfies Record<string, { summary: string; body: string }>;

function formatCommandListArg(commandName: string, schema: CommandSchema, arg: string): string {
  const optional = arg.endsWith('?');
  const name = optional ? arg.slice(0, -1) : arg;
  const isChoiceLiteral = /^[a-z-]+(?:\|[a-z-]+)+$/i.test(name);
  const isLiteralToken =
    isChoiceLiteral ||
    (schema.usageOverride !== undefined &&
      schema.usageOverride.startsWith(`${commandName} ${name}`));
  if (optional) {
    if (isChoiceLiteral) return `[${name}]`;
    if (isLiteralToken) return name;
    return `[${name}]`;
  }
  return isLiteralToken ? name : `<${name}>`;
}

function buildCommandListUsage(commandName: string, schema: CommandSchema): string {
  if (schema.listUsageOverride) return schema.listUsageOverride;
  const positionals = (schema.positionalArgs ?? []).map((arg) =>
    formatCommandListArg(commandName, schema, arg),
  );
  return [commandName, ...positionals].join(' ');
}

function renderUsageText(): string {
  return renderCliHelpOverview();
}

function renderFullCommandReferenceText(): string {
  const header = `agent-device help commands

Full command catalog. Use agent-device help <command> for exact flags and behavior.
`;

  const commands = listCliCommandNames().map((name) => {
    const schema = getCliCommandSchema(name);
    return {
      name,
      schema,
      usage: buildCommandListUsage(name, schema),
    };
  });
  const commandLines = renderCommandSection(commands);

  const selectionSection = renderFlagSection(
    // "shared by", not "accepted by every": a few catalog commands take a subset (connect has
    // no --udid/--serial, device has no --session) — help <command> states each command's own.
    "Device Selection (shared by device commands; help <command> lists each command's flags):",
    listHelpFlags(DEVICE_SELECTION_FLAG_KEYS),
  );
  const helpFlags = listHelpFlags(GLOBAL_FLAG_KEYS);
  const flagsSection = renderFlagSection('Global Flags:', helpFlags);
  const configSection = renderTextSection('Configuration:', CONFIGURATION_LINES);
  const environmentSection = renderAlignedSection('Environment:', ENVIRONMENT_LINES);
  const examplesSection = renderTextSection('Examples:', EXAMPLE_LINES);

  return `${header}
${commandLines}

${selectionSection}

${flagsSection}

${configSection}

${environmentSection}

${examplesSection}
`;
}

export function buildUsageText(): string {
  return renderUsageText();
}

function listHelpFlags(keys: ReadonlySet<FlagKey>): FlagDefinition[] {
  return getFlagDefinitions().filter(
    (definition) =>
      keys.has(definition.key) &&
      definition.usageLabel !== undefined &&
      definition.usageDescription !== undefined,
  );
}

// Command-specific override for a shared flag's help text (see CommandSchema.flagDescriptionOverrides):
// keeps the FlagDefinition registry as one shared row per flag while letting a command whose
// semantics genuinely differ (e.g. `replay --save-script` arms a repair transaction, not the
// open/close authoring lifecycle) show its own description without duplicating the flag entry.
function applyFlagDescriptionOverrides(
  definitions: FlagDefinition[],
  overrides: Partial<Record<FlagKey, string>> | undefined,
): FlagDefinition[] {
  if (!overrides) return definitions;
  return definitions.map((definition) => {
    const override = overrides[definition.key];
    return override === undefined ? definition : { ...definition, usageDescription: override };
  });
}

function renderFlagSection(title: string, definitions: FlagDefinition[]): string {
  return renderAlignedSection(
    title,
    definitions.map((flag) => ({
      label: flag.usageLabel ?? '',
      description: flag.usageDescription ?? '',
    })),
  );
}

// Cap the alignment column so one long outlier label (for example a
// combined tv-remote usage string) does not force padding whitespace onto
// every other row. Rows whose label exceeds the cap fall back to a plain
// two-space gap; they still read fine and every regex in the test suite
// only requires \s{2,}, never an exact column width.
const ALIGN_CAP = 26;

function renderAlignedSection(
  title: string,
  items: ReadonlyArray<{ label: string; description: string }>,
): string {
  if (items.length === 0) {
    return `${title}\n  (none)`;
  }
  const columnWidth = Math.max(...items.map((item) => Math.min(item.label.length, ALIGN_CAP))) + 2;
  const lines = [title];
  for (const item of items) {
    const label =
      item.label.length <= ALIGN_CAP ? item.label.padEnd(columnWidth) : `${item.label}  `;
    lines.push(`  ${label}${item.description}`);
  }
  return lines.join('\n');
}

function renderTextSection(title: string, lines: ReadonlyArray<string>): string {
  if (lines.length === 0) {
    return `${title}\n  (none)`;
  }
  return [title, ...lines.map((line) => `  ${line}`)].join('\n');
}

function renderCommandSection(
  commands: Array<{ name: string; schema: CommandSchema; usage: string }>,
): string {
  return renderAlignedSection(
    'Commands:',
    commands.map((command) => ({
      label: command.usage,
      description: command.schema.text.summary,
    })),
  );
}

export function buildCommandUsageText(commandName: string): string | null {
  const topicHelp = buildHelpTopicUsageText(commandName);
  if (topicHelp) return topicHelp;
  const schema = getCommandSchema(commandName);
  if (!schema) return null;
  const usage = buildCommandUsage(commandName, schema);
  const commandFlags = applyFlagDescriptionOverrides(
    listHelpFlags(new Set<FlagKey>(schema.allowedFlags ?? [])),
    schema.flagDescriptionOverrides,
  );
  const sections: string[] = [];
  if (commandFlags.length > 0) {
    sections.push(renderFlagSection('Command flags:', commandFlags));
  }
  const flagsSections = sections.length > 0 ? `\n\n${sections.join('\n\n')}` : '';

  // One synopsis, not two: the header used to repeat the Usage block verbatim.
  return `Usage:
  agent-device ${usage}

${helpBody(schema.text)}${flagsSections}
`;
}

/**
 * Topic-id registry view for conformance tooling: the help benchmark's topic
 * coverage gate enumerates this instead of a hand-maintained list, so adding a
 * topic without benchmark coverage (or an explicit waiver) fails a test.
 */
export function helpTopicIds(): string[] {
  return Object.keys(HELP_TOPICS);
}

function buildHelpTopicUsageText(topicName: string): string | null {
  const topic = HELP_TOPICS[topicName as keyof typeof HELP_TOPICS];
  if (!topic) return null;
  const body = topicName === 'commands' ? renderFullCommandReferenceText() : topic.body;
  return `${withVersionHeader(topicName, body)}

Related:
  agent-device help <command>   command-specific flags
  agent-device help manual-qa   routine QA loop
  agent-device help workflow    full automation reference
`;
}

// Every topic body's first line is authored as `agent-device help <topicId>`. Swapping in the
// installed version here (instead of hand-editing every topic string) gives the skill router a
// single, reliable header to read the CLI version from without a separate --version call: a
// missing/old header on `help workflow` means an old CLI that predates this format.
function withVersionHeader(topicId: string, body: string): string {
  const legacyHeader = `agent-device help ${topicId}`;
  if (!body.startsWith(legacyHeader)) return body;
  return `agent-device ${readVersion()} — ${topicId}${body.slice(legacyHeader.length)}`;
}
