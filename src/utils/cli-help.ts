import { listCliCommandNames } from '../command-catalog.ts';
import {
  getCliCommandSchema,
  getCommandSchema,
  getFlagDefinitions,
  GLOBAL_FLAG_KEYS,
  type CommandSchema,
  type FlagDefinition,
  type FlagKey,
} from './command-schema.ts';

const AGENT_WORKFLOWS = [
  {
    label: 'agent-device help workflow',
    description: 'Start here for the core loop, command shape, refs/selectors, and verification',
  },
  {
    label: 'agent-device help debugging',
    description: 'Use when logs, network, perf memory, traces, alerts, or diagnostics matter',
  },
  {
    label: 'agent-device help react-native',
    description: 'Use when the target app is React Native, Expo, or a dev client',
  },
  {
    label: 'agent-device help react-devtools',
    description: 'Use when inspecting components, props/state/hooks, renders, or profiles',
  },
  {
    label: 'agent-device help cdp',
    description: 'Use when investigating JS heap growth, heap snapshots, or retainers',
  },
  {
    label: 'agent-device help physical-device',
    description: 'Use when using a connected phone/tablet or iOS signing setup',
  },
  {
    label: 'agent-device help remote',
    description: 'Use when working through cloud config, tenants, leases, or local tunnels',
  },
  {
    label: 'agent-device help web',
    description: 'Use when automating a browser through agent-device sessions',
  },
  {
    label: 'agent-device help macos',
    description: 'Use when targeting desktop, frontmost app, or menu bar surfaces',
  },
  { label: 'agent-device help dogfood', description: 'Use when producing exploratory QA evidence' },
] as const;

const AGENT_START_LINES = [
  'agent-device is the default automation surface for app/device workflows across supported targets.',
  'Default to agent-device for installs, opens, snapshots, interactions, screenshots, logs, network/perf evidence, and verification.',
  'Use raw adb, simctl, xcrun, or platform scripts only when this help calls out a tool gap or platform setup step.',
  'Start with agent-device help workflow to understand the core loop and how to use the tool.',
] as const;

const AGENT_QUICKSTART_LINES = [
  'Planning output contract: when asked to plan commands, output command lines only: no prose, numbering, Markdown fences, pipes, or shell helpers.',
  'Default loop: devices/apps -> open -> snapshot -i -> press/fill/get/is/wait/find -> verify -> close.',
  'Use selectors or refs as positional targets: id="submit", label="Allow", or @e12 from snapshot -i.',
  'Plain snapshot reads state; snapshot -i refreshes current interactive refs only.',
  'Default snapshot text is an agent-facing, token-efficient view for planning and targeting actions.',
  'Read-only visible/state question: use snapshot/get/is/find; use snapshot -i only when refs are needed.',
  'Anti-pattern: snapshot -i followed by snapshot -i | grep ...; prior refs stay valid until app state changes, and --force-full is the explicit full re-read.',
  'Truncated text/input preview: expand first with snapshot -s @e12, not get text.',
  'React Native apps: read help react-native for Metro, DevTools routing, and RN-specific blockers; use react-native dismiss-overlay for LogBox/RedBox overlays.',
  'React Native JS memory leaks: read help cdp; use heap usage samples for a quick signal, then snapshot diff/leak-triplet for retained object proof.',
  'Android RN/Expo Metro: direct Android localhost URL opens with a port auto-configure host reachability.',
  'Expo Go/dev clients: use the provided URL when given; on iOS use open "Expo Go" <url> --platform ios, then snapshot -i --platform ios to verify project UI. Do not use plain snapshot or snapshot --diff for this recovery check. Android URL opens infer the foreground package for logs/perf when possible.',
  'Install flows: install/install-from-source first, then open the installed id with --relaunch.',
  'Text: fill \'id="field-email"\' "qa@example.com" replaces; type appends after press.',
  'Clearing text: do not use fill <target> ""; use a visible clear/reset control or report that clearing is unsupported.',
  'Android IME capture: if fill says input was captured by the keyboard/IME, inspect keyboard state and switch/disable handwriting before retrying; do not loop fill/type.',
  'Implicit default sessions are scoped to the current worktree; if a prompt names a Session, include --session <name> on every command in that flow.',
  'Run mutating commands serially within one session; parallelize only read-only commands or separate sessions/devices.',
  'Clipboard limits: iOS Allow Paste cannot be automated through XCUITest; prefill with clipboard write. Android non-ASCII should use fill/type, not raw adb input.',
  'After mutation: refs are stale. If the next target is known, use its selector directly; otherwise refresh with snapshot -i, scoped with -s when a stable container is known. Do not use tap; use press or click.',
  'Raw coordinates are fallback-only: use snapshot -i --json rects when iOS refs no-op or child refs are missing, then verify the action with diff snapshot -i or snapshot --diff.',
  'Sparse or AX-unavailable snapshot: use screenshot for visual truth, press the visible coordinate to leave the bad screen, then retry AX with snapshot -i.',
  'macOS context menus use click <ref> --button secondary, then snapshot -i. Longpress is for mobile hold gestures, not macOS secondary-click menus.',
  'Direct proxy: Cloud/Linux clients can use iOS simulators through a Mac running agent-device proxy. A proxy URL/token means direct proxy mode: use --daemon-base-url plus --daemon-auth-token, or saved daemonBaseUrl/daemonAuthToken config.',
  'Direct proxy sessions: choose one explicit --session and reuse it for open/snapshot/interactions/close; do not use connect, --remote-config, tenant, run, or lease flags.',
  'Cloud/remote-config profiles are separate from direct proxy: use connect or --remote-config on operational commands. Do not substitute --config; --config only loads CLI defaults.',
  'Batch JSON steps use "command" and structured "input"; legacy "positionals"/"flags" steps still run in CLI but are deprecated until the next major version.',
  'Navigation: app-owned back uses back; system back uses back --system.',
  'Web browser sessions: read help web; first slice is web setup if needed -> web doctor -> open <url> --platform web -> snapshot -i -> click/fill/get/is/find/wait/screenshot -> close.',
  'Verification commands must name the expected text/selector; bare screenshots/snapshots are not enough.',
  'Debug evidence: Session state contains request diagnostics and runner.log; use logs clear --restart/mark/path, trace, and network dump --include headers for app evidence.',
  'Full operating guide: agent-device help workflow. Exploratory QA: agent-device help dogfood.',
] as const;

const CONFIGURATION_LINES = [
  'Default config files: ~/.agent-device/config.json, ./agent-device.json',
  'Use --config <path> or AGENT_DEVICE_CONFIG to load one explicit config file.',
] as const;

const ENVIRONMENT_LINES = [
  { label: 'AGENT_DEVICE_SESSION', description: 'Explicit session name' },
  { label: 'AGENT_DEVICE_PLATFORM', description: 'Default platform binding' },
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
  'agent-device open TextEdit --platform macos',
  'agent-device snapshot -i',
  'agent-device react-devtools get tree --depth 3',
  'agent-device cdp memory usage sample --gc --label baseline',
  'agent-device fill @e3 "test@example.com"',
  'agent-device replay ./session.ad',
  'agent-device test ./suite --platform android',
] as const;

const HELP_TOPICS = {
  workflow: {
    summary: 'Normal agent-device bootstrap, exploration, and validation loop',
    body: `agent-device help workflow

Version-matched operating guide for normal agent-device work.

Core loop:
  devices/apps -> open -> snapshot or snapshot -i -> get/is/find/wait or press/fill/scroll/back -> verify -> close

Command shape:
  Plans should use agent-device commands, not raw platform tools, pseudo commands, package-manager aliases, or helper prose.
  If the user asks for a command plan, final output should be command lines only: no intro sentence, numbered list, Markdown fence, shell pipe, grep/head/tail helper, or explanatory bullets.
  Put subcommand first, then positionals, then flags:
    agent-device open com.example.app --session checkout --platform android --relaunch
    agent-device record start ./checkout.mp4 --session checkout
  Snapshot refs look like @e12. After snapshot -i, use the exact @eN ref from that output.
  If the exact ref is not known yet, first output snapshot -i, then use a concrete example shape like press @e12 in the next command; do not write @<ref>, @ref, @Label_Name, or @eN placeholders.
  Close means agent-device close. App-owned back means back; system back means back --system.
  Taps are press or click; tap is not a command. Gestures use swipe, longpress, or gesture <pan|fling|swipe|pinch|rotate|transform>. Use gesture swipe left|right for reliable in-page horizontal swipes, and gesture swipe right-edge for left-edge navigation/back gestures. Android swipe, pinch, rotate, and transform use provider-native touch injection when available, then the bundled touch helper. iOS simulator transform uses private XCTest synthesis for a continuous two-finger pan/scale/rotation path; otherwise it reports UNSUPPORTED_OPERATION.

Bootstrap:
  agent-device devices --platform ios
  agent-device apps --platform android
  agent-device open MyApp --platform ios --device "iPhone 17 Pro"
  agent-device open <discovered-app-id> --session checkout --platform android
  agent-device install com.example.app ./dist/app.apk --platform android
  agent-device reinstall com.example.app ./build/MyApp.app --platform ios
  agent-device install-from-source --github-actions-artifact org/repo:app-debug --platform android
  agent-device open com.example.app --platform android --relaunch
  agent-device prepare ios-runner --platform ios --timeout 240000
  If app id is unknown, plan devices, apps, then open <discovered-app-id>. Discovery is not enough when the task asks to open/start the app.
  Install arguments are app/package id then artifact path. If the task says install, use install; use reinstall only when explicitly requested. Fresh runtime state is open --relaunch after install.
  In Apple CI, run prepare ios-runner after boot/install and before replay/test. prepare ios-runner builds/reuses the XCTest runner, health-checks it with a lightweight command, and retries one stuck/non-connecting runner launch before the first snapshot pays that setup cost. It is not a recovery step for "runner already owned by another agent-device daemon"; stop or clean the owning daemon on the Mac with simulator access instead. If the replay/test step starts a separate daemon, run clean:daemon after prepare so the prepared runner does not keep a live lease owned by the prepare daemon.
  CI may cache ~/.agent-device/ios-runner/derived with an exact key that includes the agent-device package and Xcode version. Avoid broad restore-key fallbacks; prepare ios-runner already recovers bad restored runner artifacts and one retryable non-connecting runner launch. Runner build/start output is written to the session's runner.log; daemon.log is for daemon lifecycle/startup issues.
  Do not open artifact paths or invent package ids. If apps lookup misses the target and no URL/artifact is provided, ask or stop.

Snapshots and refs:
  snapshot reads visible state. snapshot -i gets current interactive refs only; it is the fast path when the next step is an interaction.
  Default snapshot text is an agent-facing, token-efficient view for planning and targeting actions; use --raw or --json only when you need the full provider tree.
  Snapshot legend:
    @e12 [button] label="Add to cart" id="add-cart" enabled hittable -> press @e12 or press 'id="add-cart"'.
    @e13 [textinput] label="Notes" preview="Leave at side..." truncated -> snapshot -s @e13 before reading.
    @e14 [cell] label="Profiles" focused -> tvOS focus is currently on this row.
    [off-screen below] 4 items: "Privacy", "About" -> scroll down, then snapshot -i; those are hints, not refs.
  Re-snapshot after navigation, submit, typing/fill, modal/list/reload/dynamic changes when you need new refs.
  Anti-pattern: snapshot -i followed by snapshot -i | grep ...
  Refs from the first snapshot remain valid until you press, click, fill, type, scroll, go back, wait for async UI, or otherwise change app state.
  After a mutation, prefer a known selector/label directly (for example press 'label="Send"') because interaction commands refresh interactive state internally. If you need to discover the new control, use snapshot -i, or snapshot -i -s "Composer" when a stable container label/id can scope the refresh.
  If typing/fill opened the keyboard or changed layout and the next target has no stable selector, run snapshot -i, use the fresh ref, then verify with wait/find or diff snapshot -i.
  For a targeted query, use find/get/is. If you truly need the full tree again, pass --force-full.
  Off-screen summaries are scroll hints; use scroll, not swipe, then snapshot -i.
  Missing target in a long list: use a short manual scroll + snapshot loop with a max attempt count. If a named target is summarized as off-screen below/above, use scroll down/up, then snapshot -i; do not use scroll bottom/top because the target may appear before the absolute list edge. Use scroll bottom/top only when the task explicitly asks for the list edge. Edge scrolls verify hidden content with snapshots and stop when no matching hidden content remains.
  Truncated text/input previews: do not use get text first; expand with snapshot -s @ref (for example snapshot -s @e7), then read the scoped output.
  Rare iOS accessibility gaps: if a row ref is shown disabled/hittable:false and press @ref reports success but no UI change, or a horizontal tab/filter bar is collapsed into one composite/seekbar with no child refs, run agent-device snapshot -i --json to read rects, compute the target center, press x y, then diff snapshot -i. Coordinates are fallback-only; document why you used them.

Selectors:
  Use selectors as positional targets: id="field-email" or label="Allow".
  Do not use CSS selectors, pseudo refs, --selector, --text, or raw x/y when refs/selectors exist.
    agent-device fill 'id="catalog-search"' "tart" --delay-ms 80
    agent-device press 'id="submit-order"'
    agent-device is visible 'label="Online"'
    agent-device get text 'id="quantity-value"'

Text entry:
  fill replaces; type appends to focused field.
    agent-device fill @e5 "qa@example.com"
    agent-device fill 'id="field-email"' "qa@example.com"
    agent-device press 'id="product-note"'
    agent-device type "Handle with care" --delay-ms 80
  Empty replacement is not a supported clear-field command: do not plan fill <target> "" or fill <target> ''. Prefer a visible clear/reset control; if the app exposes none, report the tool gap instead of inventing a clear command.
  Debounced field with no result selector: agent-device wait 1000. Keyboard read-only: keyboard status/get. Blocked control: try keyboard dismiss when supported.
  On iOS, prefer keyboard dismiss before manually pressing visible Done; the runner can use safe native keyboard controls and still reports unsupported layouts explicitly. If it returns UNSUPPORTED_OPERATION, prefer a visible app dismiss control, or use back --system only when system navigation is an acceptable side effect.
  Use plain fill/type first for ordinary login and form fields. If an iOS debounced or search-as-you-type field actually drops characters, or must receive incremental updates, retry with --delay-ms before trying clipboard paste; --delay-ms intentionally paces character entry.
  iOS Allow Paste prompt cannot be exercised under XCUITest. To test paste-driven app behavior, prefill first with agent-device clipboard write "some text"; test the system prompt manually.
  Android Gboard handwriting/stylus UI can capture text in an IME-owned input instead of the app field. If fill reports that input was captured by the keyboard/IME, use the diagnostic targetInput/actualInput details, inspect keyboard status/get if needed, and switch or disable handwriting outside the command plan before retrying. Do not keep retrying fill/type against the same field while the IME owns focus.
  Android text entry is owned by agent-device: provider-native text injection when available, then chunk-safe ASCII shell input. Do not switch to raw adb, clipboard, or paste as an agent fallback. If non-ASCII is unsupported in the current backend, report the tool/device gap.

Session ordering:
  Stateful commands within one session must run serially. Do not run open/press/fill/type/scroll/back/alert/replay/batch/close commands in parallel against the same session.
  It is fine to parallelize independent read-only collection or commands that use different sessions/devices.

Read-only and waits:
  Read-only visible/state question: use snapshot/get/is/find.
  agent-device snapshot
  agent-device get text 'id="product-title"'
  agent-device get attrs @e4
  agent-device is visible 'label="Online"'
  agent-device wait text "Refreshing metrics..." 3000
  agent-device wait 'label="Ready"' 3000
  agent-device find "Increment" press --json
  For async/list text presence, prefer wait text over is visible when no interaction is needed.
  Use snapshot -i only when refs are needed for an action or targeted query.
  Ambiguous find: add --first or --last. If info is not visible/exposed, report that gap instead of typing/searching/navigating to reveal it.

Navigation and gestures:
  Use scroll for lists; swipe for coordinate gestures/carousels; gesture pan for deliberate drags; gesture fling for fast directional throws.
  For fast macOS desktop list traversal, prefer fixed pixel wheel steps and batch them when no snapshot is needed between passes:
    agent-device scroll down --pixels 200 --duration-ms 50 --platform macos
    agent-device batch --steps '[{"command":"scroll","input":{"direction":"down","pixels":200,"durationMs":50}},{"command":"scroll","input":{"direction":"down","pixels":200,"durationMs":50}}]' --platform macos
  For raw coordinate gestures, run snapshot -i first and choose a point near the center of the intended app-owned target. Avoid screen edges, tab bars, navigation bars, and home indicators because those areas can trigger system or app navigation instead of the gesture under test.
  If app-owned back is ambiguous or has just misrouted, prefer a visible nav/back button ref, tab-bar ref, or deep link over repeated back/system back.
  App-owned action sheets, menus, and camera/scan screens are normal UI. After opening one, run snapshot -i or wait for the option, press by label/ref, handle visible permission sheets through UI or platform-supported native alerts, then wait for a concrete result before returning to chat/form state.
  Keep count/pause/pattern on one swipe; flags are --count, --pause-ms, --pattern ping-pong.
  longpress accepts coordinates, @refs, or selectors. Prefer @ref/selector from snapshot -i; use coordinates only as a fallback when accessibility refs miss the exact target. Duration and gesture scale/center are positional:
    agent-device longpress 300 500 800
    agent-device longpress @e12 800
    agent-device swipe 320 500 40 500 --count 8 --pause-ms 30 --pattern ping-pong
    agent-device gesture pan 200 420 0 -80 500
    agent-device gesture fling right 200 420 180
    agent-device gesture pinch 0.5 200 400
    agent-device gesture rotate 35 200 420
    agent-device gesture transform 200 420 80 -40 2 35 700
  iOS simulator transform uses private XCTest synthesis for a continuous two-finger pan/scale/rotation path; verify app metrics instead of assuming requested values map exactly to recognizer output.
  Android transform injects a geometric two-finger path; app recognizers may report non-exact pan/scale/rotation. For Android combined transforms, verify semantic app state or coarse per-component effects instead of exact numeric deltas unless the app explicitly exposes stable metrics.
    agent-device gesture transform 200 420 80 -40 2 35 700 --platform android
    agent-device wait text "pan changed yes" 3000 --platform android
    agent-device wait text "pinch changed yes" 3000 --platform android
    agent-device wait text "rotate changed yes" 3000 --platform android
  If Android needs exact app-state values, prefer isolated gesture pan, gesture pinch, or gesture rotate commands over one combined transform.
  macOS context menus are secondary clicks, not long presses:
    agent-device click @e66 --button secondary --platform macos
    agent-device snapshot -i --platform macos

Validation and evidence:
  Nearby mutation diff: agent-device diff snapshot -i.
  Expected text/selector verification must include the exact text or selector via wait, is, get, or find; bare screenshots/snapshots are insufficient for named expectations.
  When an action is only a means to reveal or reach an expected target, do not stop at the action itself. Follow it with exact target verification using the id, selector, or text named by the task.
  Prefer provided testIDs/ids/selectors for verification; use visible text when no durable selector is provided.
  If task says snapshot, use snapshot. If it asks visual evidence, use screenshot.
  Icon/tappable visual proof: screenshot --overlay-refs. Flag is --overlay-refs.
  If snapshot returns a sparse/AX-unavailable state, refs are not reliable. Use plain screenshot, not screenshot --overlay-refs, navigate with coordinates if needed, then retry snapshot -i after reaching another screen; the AX failure may be screen-specific.
    agent-device screenshot
    agent-device press 124 817
    agent-device snapshot -i
  Startup/CPU/memory/frame first pass: perf metrics --json (bare perf and metrics are aliases). Focused frame/jank health: perf frames --json. Memory-only sample: perf memory sample --json returns compact JSON with bounded top offenders. Heap/memgraph artifact escalation: perf memory snapshot --out heap.artifact; use --kind android-hprof on Android or --kind memgraph on supported Apple simulator/macOS app sessions. Android native profiling: perf cpu profile start|stop|report --kind simpleperf --out <path>; Android native traces: perf trace start|stop --kind perfetto --out <path>. Artifact collectors return compact state/path/size metadata only; raw heap/profile/trace files stay on disk. Treat native perf output as the agent evidence: for example, a Perfetto stop can return state=stopped, outPath=/tmp/app.perfetto-trace, sizeBytes=5392410, and method=adb-shell-perfetto while the 5.3 MB raw trace stays in the artifact. This is better than raw dumps for agents because it is stable, bounded, and keeps large artifacts out of context. heapprofd is deferred until Perfetto plumbing is available. Replay maintenance: replay -u ./flow.ad.
  Recording: record start/stop. Use --max-size to cap the longest edge and --quality medium|high to choose output quality across Android and Apple targets. By default, stop burns touch overlays into the video; use record start --hide-touches for the fastest raw recording. Android adb screenrecord has a 180s platform limit, so longer Android recordings are returned as multiple MP4 chunks. For gesture-heavy iOS simulator proof videos, prefer --hide-touches because overlay timing depends on a stable runner session while gestures are executing. Tracing: trace start ./trace.log, trace stop ./trace.log. Paths are positional.
  Stable known flow: batch ./steps.json, not workflow batch.
  Inline batch JSON example:
    agent-device batch --steps '[{"command":"open","input":{"app":"settings"}},{"command":"wait","input":{"kind":"duration","durationMs":100}}]'
  Batch step keys are command, input, and optional runtime. Put command arguments inside input using the same fields as the MCP/Node command. CLI still accepts legacy positionals/flags steps with a deprecation warning until the next major version.
  Never use args, step positionals, or flags for new batch JSON; put command inputs under input.
  Android animations: settings animations off/on, not animations disable/restore.
  Debug logs: logs clear --restart, logs mark, reproduce, then logs path; do not split clear/restart into separate stop/start commands.
  Network headers: network dump --include headers; do not write network log headers.
  Direct proxy to a Mac you control: cloud/Linux clients can still use iOS simulators through the proxied Mac. Use the printed /agent-device daemon base URL and auth token, or store them as daemonBaseUrl and daemonAuthToken in agent-device.json. Use one explicit --session across open, snapshot, interactions, and close. Do not use connect, --remote-config, tenant, run, or lease flags for direct proxy simulators.
  Cloud/remote-config profiles: use connect to discover a cloud profile, or connect --remote-config ./remote-config.json for a local profile; then open, snapshot, disconnect.
  Web: agent-device uses a managed, pinned agent-browser backend as an implementation detail. Use --platform web when a browser step belongs inside an agent-device session, replay, batch, MCP, or typed-client flow; use agent-browser directly for standalone web automation. Run agent-device web setup before first use, then agent-device web doctor for backend health checks. Web automation requires Node 24+.
    agent-device web setup
    agent-device web doctor
    agent-device open https://example.com --platform web
    agent-device snapshot -i --platform web
    agent-device get text @e2 --platform web
    agent-device is visible 'label="Welcome"' --platform web
    agent-device find text "Welcome" exists --platform web
    agent-device click @e12 --platform web
    agent-device fill @e13 "qa@example.com" --platform web
    agent-device wait text "Welcome" 3000 --platform web
    agent-device record start ./artifacts/web-flow.webm --platform web
    agent-device network dump 25 --include headers --platform web
    agent-device screenshot ./artifacts/web-home.png --platform web
    agent-device screenshot ./artifacts/web-full.png --platform web --fullscreen
    agent-device viewport 1280 900 --platform web
    agent-device record stop --platform web
    agent-device close --platform web
  Minimal web support is for browser sessions with open, snapshot, find, get, is, click/press, fill/type, wait, network dump, screenshot, record start/stop with WebM output, close, and replay over those commands. Use agent-browser directly for browser-specific features that agent-device does not surface, such as tab/devtools management, advanced page scripting, network routing/HAR, or raw browser debugging.
  macOS menu bar: open ... --platform macos --surface menubar; snapshot -i --platform macos --surface menubar.
  Maestro full-suite validation on explicit connected devices uses one test command with a comma-separated --device list and --shard-all. Use --shard-split only when splitting suite entries across devices:
    agent-device test ./e2e/maestro --maestro --device udid1,emulator-5554 --shard-all 2

React Native dev loop:
  JS-only change with Metro connected:
    agent-device metro reload
    agent-device find "Home"
  Do not use agent-device reload. Use open --relaunch for native startup reset.
  React Native apps: use help react-native for Metro/Fast Refresh, DevTools routing, and RN-specific blockers; use react-native dismiss-overlay for LogBox/RedBox overlays.
  Android RN/Expo Metro: direct Android URL opens to localhost/127.0.0.1/[::1] with a port auto-configure host reachability. Manual adb reverse tcp:<port> tcp:<port> is only needed for app/package launches or unsupported flows where the app cannot reach local Metro.
  Expo Go is a host shell. Use a provided project URL instead of inventing a bundle id; if no URL is provided but a target/app name is provided, open that target and do not inspect project files to find one. On iOS, prefer host + URL when the host shell is known because direct URL open can report success while leaving the runner/shell focused; verify with snapshot -i after opening:
    agent-device open "Expo Go" exp://127.0.0.1:8081 --platform ios
    agent-device snapshot -i --platform ios
  If recovery follows a runner/shell splash screen, use snapshot -i --platform ios; do not substitute plain snapshot or snapshot --diff.
  There is no open-url command; use open with the URL target or host + URL form.
  Direct iOS URL open remains valid when no host shell is known, but verify that the app UI loaded:
    agent-device open exp://127.0.0.1:8081 --platform ios
  Android uses the URL target directly; do not write open <app> <url> there:
    agent-device open exp://127.0.0.1:8081 --platform android
  Android URL/deep-link opens infer the foreground package after launch when possible, so logs/perf can remain package-bound. If perf still says no package is associated, open the host package/app id first, then open the URL in the same session.
  If apps lookup misses the project but shows Expo Go/dev-client and a project URL is available, open the URL/host shell; if no URL is available, ask instead of inventing an app id.
  Expo Dev Client/development builds: open the installed dev-client app id/name; if a dev-client URL is provided, open that URL next. For Metro setup use metro prepare --kind expo.

Escalate:
  help debugging       logs, network, alerts, traces, flaky runtime failures
  help react-devtools  React Native performance, profiling, props/state/hooks, slow renders, rerenders
  help react-native   React Native app automation hazards, overlays, Metro, and routing
  help remote          remote/cloud config, tenant, lease, local service tunnels
  help macos           desktop, frontmost-app, menu bar surfaces
  help dogfood         exploratory QA report workflow`,
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
  For iOS simulator launch-time stdout/stderr, use --launch-console on the direct app launch:
    agent-device open MyApp --platform ios --relaunch --launch-console ./artifacts/app.console.log
  --launch-console is only for direct iOS simulator app launches, not URL opens.

Network:
  Use network dump for recent session HTTP traffic parsed from app logs.
    agent-device network dump --include headers
    agent-device network dump 20 --include all
  Use this instead of logs path when the question is request/response metadata.
  network log is a supported alias, but network dump --include headers is the clearest plan form. Do not write network log headers.

Crash symbolication:
  Crash routing:
    Use logs when you need the lead-up timeline before a failure.
    Use debug symbols when you have crash.ips/crash.log plus a matching dSYM/build directory and need the failing frame.
    Use Xcode/LLDB when you need live state, breakpoints, variables, memory, or stepping.
  Use debug symbols when you already have an Apple crash artifact and local dSYMs and need the failing code path, not a full log dump:
    agent-device debug symbols --artifact crash.log --dsym MyApp.dSYM --out crash-symbolicated.log
    agent-device debug symbols --artifact crash.ips --search-path ./build --out crash-symbolicated.ips
  debug is intentionally narrow. Do not use it for logs, network evidence, performance samples, recordings, traces, or React Native internals.
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
  Open output includes Session state; JSON also includes runnerLogPath and requestLogPath.
  Session requests/<request-id>.ndjson holds daemon request diagnostics; session runner.log holds Apple runner/xcodebuild output.
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
  perf xctrace returns artifact paths and compact metadata only. Do not dump .trace contents into context.
  For Android native CPU/trace evidence, use perf artifacts instead of raw adb/simpleperf/perfetto output:
    agent-device perf cpu profile start --kind simpleperf --out /tmp/cpu.perf.data
    agent-device perf cpu profile stop --kind simpleperf
    agent-device perf cpu profile report --kind simpleperf --out /tmp/cpu-report.json
    agent-device perf trace start --kind perfetto --out /tmp/app.perfetto-trace
    agent-device perf trace stop --kind perfetto
  Treat native perf output as the agent evidence: for example, state=stopped, outPath=/tmp/app.perfetto-trace, sizeBytes=5392410, method=adb-shell-perfetto. The 5.3 MB raw trace stays in the artifact.

Memory diagnostics:
  Use perf memory when the symptom is leak/growth/OOM suspicion and you need agent-readable evidence.
    agent-device perf memory sample --json
    agent-device perf memory snapshot --kind android-hprof --out ./artifacts/app.hprof
    agent-device perf memory snapshot --kind memgraph --out ./artifacts/app.memgraph
  Example sample shape:
    {"metrics":{"memory":{"available":true,"totalPssKb":562958,"totalRssKb":570304,"topConsumers":[{"name":"Dalvik Heap","pssKb":213456}]}}}
  Example default snapshot output:
    Memory artifact (android-hprof): /tmp/app.hprof (42MB)
  Prefer perf memory sample over raw dumpsys/leaks output for first-pass agent diagnosis: it keeps arrays bounded, preserves the same memory source as perf metrics, and returns only memory data instead of startup/CPU/frame noise.
  Prefer perf memory snapshot over printing heap/memgraph data: snapshots return path, size, kind, method, and support metadata while the large artifact stays on disk for external inspection.
  Unsupported platforms return artifact.available=false with reason/hint; do not pretend a heap or memgraph was captured.

Stabilizers:
  Android animation-sensitive flows:
    agent-device settings animations off
    agent-device snapshot
    agent-device settings animations on
  Re-enable settings you changed before finishing.

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

Use snapshot, screenshot, logs, network, and perf metrics for device/app runtime evidence. Use react-devtools only when component internals or React rendering behavior matters.`,
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
  Generic navigation, selectors, refs, verification, serial commands: help workflow.
  Logs, network, diagnostics, traces, permission dialogs, or runtime failures: help debugging.
  Component tree, props/state/hooks, slow renders, rerenders, or render causes: help react-devtools.
  JS heap growth, heap snapshots, allocation hotspots, or retained-object leaks: help cdp.
  Remote/cloud config, leases, and local service tunnels: help remote.

React Native dev loop:
  For "start from screen X" flows, prefer open --relaunch before the first snapshot so the app does not reuse a prior in-progress navigation state.
  JS-only change with Metro connected:
    agent-device metro reload
    agent-device find "Home"
  Do not use agent-device reload. Use open --relaunch for native startup reset.
  Android RN/Expo Metro: direct Android localhost URL opens with a port auto-configure host reachability. For app/package launches, run metro prepare when the app cannot reach local Metro.
  Verify Metro from the same host context that owns Metro. If a sandboxed shell cannot curl localhost:8081/status but an unrestricted host shell can, Metro is running and the sandbox probe is not authoritative.
  adb reverse only affects Android device-to-host traffic. It does not prove host-to-Metro reachability, and it does not fix a redbox caused by a stale or wrong Metro/app state.
  Multiple local worktrees can reuse one native iOS simulator build by running each worktree's Metro on a different port and opening the same installed app on different simulators with explicit runtime hints:
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
  If React DevTools cannot connect, report status and continue with logs, network, perf metrics, screenshot, and trace evidence instead of blocking the whole flow.

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
  Use help debugging for logs clear --restart, logs mark, network dump --include headers, perf metrics --json, traces, and runtime failure evidence.
  For 15-20s async work, use wait with the exact expected text or selector instead of repeated snapshots.
  Report React render offenders separately from network/backend waits and device frame/CPU/memory findings.`,
  },
  'physical-device': {
    summary: 'Connected phone/tablet setup and iOS signing prerequisites',
    body: `agent-device help physical-device

Use this when the target is connected hardware instead of a simulator/emulator.
For simulator/emulator workflows, use help workflow.

Discovery:
  agent-device devices --platform ios
  agent-device devices --platform android
  Use --device <name-or-udid> only when multiple devices are present.

iOS physical-device prerequisites:
  Xcode and xcrun devicectl must be available from the selected Xcode.
  The device must be paired/trusted, connected, unlocked when needed, and have Developer Mode enabled.
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
  Android does not need the iOS runner signing setup. For React Native/Expo Metro reachability, read help react-native.`,
  },
  remote: {
    summary: 'Direct proxy, cloud profiles, and remote config',
    body: `agent-device help remote

There are two different remote modes:
  1. Direct proxy: agent-device proxy exposes a Mac you control. A cloud/Linux client can use iOS simulators through that proxied Mac. Use --daemon-base-url plus --daemon-auth-token, or store daemonBaseUrl and daemonAuthToken in agent-device.json. Use one explicit --session across open, snapshot, interactions, and close so implicit cwd-scoped default sessions do not diverge. Do not use connect, --remote-config, tenant, run, or lease flags for this mode.
  2. Cloud/profile: the cloud connection profile or a local --remote-config owns daemon URL, auth, tenant, run, lease, device scope, and Metro hints. Do not restate those as individual flags unless overriding intentionally.

Direct proxy flow for a remote Mac/simulator:
  On the Mac with simulator/device access:
    agent-device proxy --port 4310
    cloudflared tunnel --url http://127.0.0.1:4310
  On the remote client:
    agent-device devices --daemon-base-url https://example.trycloudflare.com/agent-device --daemon-auth-token <token>
    agent-device open Maps --session maps --platform ios --device "iPhone 17 Pro" --daemon-base-url https://example.trycloudflare.com/agent-device --daemon-auth-token <token>
    agent-device snapshot -i --session maps --platform ios --device "iPhone 17 Pro" --daemon-base-url https://example.trycloudflare.com/agent-device --daemon-auth-token <token>
    agent-device close --session maps --daemon-base-url https://example.trycloudflare.com/agent-device --daemon-auth-token <token>

Cloud profile flow:
  agent-device connect
  agent-device open com.example.app
  agent-device snapshot
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
  Prefer --remote-config over --daemon-base-url, --tenant, --run-id, and --lease-id when using a local profile.
  Use agent-device proxy for direct tunnel access to a Mac you control. Copy the printed daemon base URL and daemon auth token; do not use agent-device auth, connect, disconnect, --remote-config, tenant, run, or lease flags for this direct proxy flow.
  For repeated direct proxy commands, store daemonBaseUrl and daemonAuthToken in normal agent-device.json CLI config. Keep platform selection on each command or workflow, and keep the same explicit --session until close.
  Keep the proxy token secret. Anyone with the token can control the proxied daemon.
  If iOS snapshot/interaction reports that the runner is already owned by another agent-device daemon, do not run prepare ios-runner from the remote client. Retry the original snapshot or interaction; same-proxy-state stale runner leases are reclaimed by the proxy daemon. If the conflict repeats, the Mac operator should close the owning session or clean the conflicting local daemon.
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
  --surface app            normal app session
  --surface frontmost-app  inspect whichever app is frontmost
  --surface desktop        desktop-wide surface
  --surface menubar        menu bar extras and menu bar-only apps

Menu bar app example:
  agent-device open "Agent Device Tester Menu" --platform macos --surface menubar
  agent-device snapshot -i --platform macos --surface menubar

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
  agent-device uses a managed, pinned agent-browser backend for browser mechanics. agent-device owns command/session/replay integration, selectors/refs at the command surface, and artifact routing; agent-browser owns browser launch, page control, screenshots, and browser-specific behavior.
  Use --platform web when a browser step belongs inside an agent-device session, replay, batch, MCP, or typed-client flow. Use agent-browser directly for standalone web automation.
  Before first use, set up and verify the managed backend:
    agent-device web setup
    agent-device web doctor
  Web automation requires Node 24+.

Planning rule:
  For web command plans, output only agent-device command lines. Do not add prose, numbering, Markdown fences, shell pipes, or agent-browser commands unless the task is explicitly standalone browser automation outside agent-device.

First-slice loop:
  agent-device web setup
  agent-device web doctor
  agent-device open https://example.com --platform web
  agent-device snapshot -i --platform web
  agent-device get text @e2 --platform web
  agent-device is visible 'label="Welcome"' --platform web
  agent-device find text "Welcome" exists --platform web
  agent-device click @e12 --platform web
  agent-device fill @e13 "qa@example.com" --platform web
  agent-device wait text "Welcome" 3000 --platform web
  agent-device record start ./artifacts/web-flow.webm --platform web
  agent-device network dump 25 --include headers --platform web
  agent-device screenshot ./artifacts/web-home.png --platform web
  agent-device screenshot ./artifacts/web-full.png --platform web --fullscreen
  agent-device viewport 1280 900 --platform web
  agent-device record stop --platform web
  agent-device close --platform web

Supported in agent-device web sessions:
  open <url>, snapshot -i, get text/attrs, is visible/exists/text, find text/selector, click/press @ref or selector, fill/type @ref or selector, wait text/selector, network dump, screenshot, record start/stop with WebM output, close, and replay scripts made from those commands.

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
  Android RN/Expo Metro: direct Android localhost URL opens with a port auto-configure host reachability.
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
  Re-snapshot after each mutation.
  Keep commands in the report reproducible; use selectors or refs from fresh snapshots, not guessed coordinates.
  Prefer refs for exploration and selectors for deterministic replay.
  Use logs, network, screenshot --overlay-refs, trace, perf metrics, perf frames, or react-devtools only when they add evidence to a specific issue.
  Never delete screenshots, videos, traces, or report artifacts during a session.
  Escalate to help debugging or help react-devtools when runtime symptoms require those tools.`,
  },
} as const satisfies Record<string, { summary: string; body: string }>;

export type HelpTopicName = keyof typeof HELP_TOPICS;

function formatPositionalArg(arg: string): string {
  const optional = arg.endsWith('?');
  const name = optional ? arg.slice(0, -1) : arg;
  return optional ? `[${name}]` : `<${name}>`;
}

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

function buildCommandUsage(commandName: string, schema: CommandSchema): string {
  if (schema.usageOverride) return schema.usageOverride;
  const positionals = (schema.positionalArgs ?? []).map(formatPositionalArg);
  const flagLabels = (schema.allowedFlags ?? []).flatMap((key) =>
    flagDefinitionsForKey(key).map((definition) => definition.usageLabel ?? definition.names[0]),
  );
  const optionalFlags = flagLabels.map((label) => `[${label}]`);
  return [commandName, ...positionals, ...optionalFlags].join(' ');
}

function flagDefinitionsForKey(key: FlagKey): FlagDefinition[] {
  return getFlagDefinitions().filter((definition) => definition.key === key);
}

function buildCommandListUsage(commandName: string, schema: CommandSchema): string {
  if (schema.listUsageOverride) return schema.listUsageOverride;
  const positionals = (schema.positionalArgs ?? []).map((arg) =>
    formatCommandListArg(commandName, schema, arg),
  );
  return [commandName, ...positionals].join(' ');
}

function renderUsageText(): string {
  const header = `agent-device <command> [args] [--json]

CLI to automate supported app, device, desktop, and web targets for AI agents.
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

  const helpFlags = listHelpFlags(GLOBAL_FLAG_KEYS);
  const flagsSection = renderFlagSection('Global Flags:', helpFlags);
  const startSection = renderTextSection('Agent Starting Point:', AGENT_START_LINES);
  const quickstartSection = renderTextSection('Agent Quickstart:', AGENT_QUICKSTART_LINES);
  const workflowsSection = renderAlignedSection('Agent Workflows:', AGENT_WORKFLOWS);
  const configSection = renderTextSection('Configuration:', CONFIGURATION_LINES);
  const environmentSection = renderAlignedSection('Environment:', ENVIRONMENT_LINES);
  const examplesSection = renderTextSection('Examples:', EXAMPLE_LINES);

  return `${header}
${startSection}

${workflowsSection}

${commandLines}

${flagsSection}

${quickstartSection}

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

function renderFlagSection(title: string, definitions: FlagDefinition[]): string {
  return renderAlignedSection(
    title,
    definitions.map((flag) => ({
      label: flag.usageLabel ?? '',
      description: flag.usageDescription ?? '',
    })),
  );
}

function renderAlignedSection(
  title: string,
  items: ReadonlyArray<{ label: string; description: string }>,
): string {
  if (items.length === 0) {
    return `${title}\n  (none)`;
  }
  const maxLabelLength = Math.max(...items.map((item) => item.label.length)) + 2;
  const lines = [title];
  for (const item of items) {
    lines.push(`  ${item.label.padEnd(maxLabelLength)}${item.description}`);
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
      description: command.schema.summary ?? command.schema.helpDescription,
    })),
  );
}

export function buildCommandUsageText(commandName: string): string | null {
  const topicHelp = buildHelpTopicUsageText(commandName);
  if (topicHelp) return topicHelp;
  const schema = getCommandSchema(commandName);
  if (!schema) return null;
  const usage = buildCommandUsage(commandName, schema);
  const commandFlags = listHelpFlags(new Set<FlagKey>(schema.allowedFlags ?? []));
  const sections: string[] = [];
  if (commandFlags.length > 0) {
    sections.push(renderFlagSection('Command flags:', commandFlags));
  }
  const flagsSections = sections.length > 0 ? `\n\n${sections.join('\n\n')}` : '';

  return `agent-device ${usage}

${schema.helpDescription}

Usage:
  agent-device ${usage}${flagsSections}
`;
}

function buildHelpTopicUsageText(topicName: string): string | null {
  const topic = HELP_TOPICS[topicName as keyof typeof HELP_TOPICS];
  if (!topic) return null;
  return `${topic.body}

Related:
  agent-device help                  command list and global flags
  agent-device help <command>        command-specific flags
  agent-device help workflow         normal app automation loop
`;
}
