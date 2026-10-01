export const WAIT_FAILURE_CONTRACT = `Wait failure contract:
  Read error.details.reason in --json, not the message text.
  wait_target_absent: a readable capture ran and found no match.
  wait_target_present: wait absent timed out with matches; details include matches and firstMatch.
  predicate_failed: wait absent had no valid capture; final observation/diagnostic is preserved.
  wait_capture_stalled: no readable capture finished before the deadline -- retriable.
  wait_deadline_exceeded: a later capture used the remaining budget after an earlier readable one.
  wait_landmark_identity_mismatch: a replay destination guard found the selector but not the recorded identity.
  wait_stable_timeout: wait stable never saw a stable UI -- not an absence verdict.
`;

export const manualQaHelpTopics = {
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
  6. Verify named expectations with wait text/selector/absent, get, is, find, or the settled diff. A bare screenshot/snapshot is not verification for a named expectation.
  7. Close the session when the script ends.

Command shapes:
  agent-device open com.example.app --relaunch
  agent-device open https://example.com/deep-link
  agent-device snapshot -i
  agent-device press @e12 --settle
  agent-device press 'label="Follow"' --settle
  agent-device fill @e13 "qa@example.com" --settle
  agent-device wait text "Order placed" 3000
  agent-device wait absent 'label="Loading..."' 3000
  agent-device close
  --relaunch forces fresh app state; a deep link/URL open does not need it. Labels with an apostrophe or quote (label="Don't leave") are shell-quoting hazards: prefer the @ref from the latest snapshot/settle output over quoting the literal label.

Targets:
  Prefer refs from the latest snapshot -i or settled diff. Use durable selectors when the label/id is known: label="Search", id="submit", role=button label="Follow". If label text matches both a field and its caption, target the field with label="Email" editable=true.
  For text fields, use fill <target> <text> --settle to replace the field value; use type only to append to an already-focused field.
  Do not use placeholders such as @ref, @eN, <button>, or <selector> in a final command plan. If the ref is unknown, first run snapshot -i.
  Coordinates are fallback-only after refs/selectors fail or accessibility omits the target; use screenshot or snapshot -i --json to choose a visible center point.

Recovery:
  Network/typeahead result missing: wait text "Expected result" or wait <selector>.
  A target that should be gone/disappear: use wait absent <selector>; wait exists ... is rejected in favor of the plain selector wait.
  Keyboard visible over the next target: an element whose center sits behind the keyboard is refused with tap_keyboard_occludes_target, because the touch would activate a key instead of the target. End editing first -- the app's own Done/Cancel control, or keyboard enter when submission is wanted -- then retry. A target whose center stays above the keys still presses; a raw coordinate behind the keyboard taps anyway and reports the reason in warning.
  Sparse or recovered accessibility snapshot: use screenshot as visual truth, leave the bad screen if needed, then retry snapshot -i.
  Non-hittable success hint: verify with the settled diff or snapshot; retarget by a better ref/selector if the UI did not change.

${WAIT_FAILURE_CONTRACT}`,
  },
} as const;

export const debuggingHelpTopics = {
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
} as const;

export const qaReportHelpTopics = {
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
  scroll takes a selector-less direction+amount form: agent-device scroll down 0.8. One gesture cannot travel further than 0.8 of the viewport axis, so a larger amount saturates rather than covering more ground; to cross several screens use agent-device scroll down --until <selector> or scroll bottom. Use --settle to wait for the UI to go quiet and get the settled diff.
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
  CI may cache ~/.agent-device/apple-runner/derived with an exact key that includes the agent-device package and Xcode version. Runner reuse is authorized only by the cache metadata's content manifest, so a restore that fails validation rebuilds; prepare ios-runner already recovers one retryable non-connecting runner launch.

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
} as const;
