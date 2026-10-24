---
title: Debugging & Profiling
---

# Debugging & Profiling

When UI automation is not enough, use these commands to collect runtime evidence from the app or device.

## What you can capture

- Session app logs for targeted debugging windows
- Network inspection from recent HTTP(s) entries in app logs via `network dump`
- Audio-level probes for browser media elements and host-rendered simulator/emulator audio
- Focused performance evidence with `perf frames`, `perf memory`, and native profile reports
- Apple crash symbolication with `debug symbols`
- Screenshots, recordings, and replayable repro flows

## React Native components

To see what React renders behind a screen, read the component tree and inspect a component:

```bash
agent-device react-devtools find ContactRow
agent-device react-devtools inspect @c42
agent-device react-devtools tree @c40 --depth 3
agent-device react-devtools errors
```

`find` and `tree` print `@c` refs. `inspect` shows the owners that rendered a component, its props, state, and hooks, and the errors and warnings it logged while rendering:

```text
@c42 ContactRow key=3
rendered by: ContactList @c40 < MemoDefeatedScenario @c38 < PerfLabScreen @c12
props:
  contact: {id: 3, name: "Ada Lovelace"}
  onSelect: ƒ onSelect() {}
hooks:
  State: false
```

`inspect` also takes a component name when only one mounted component has it. `errors` lists the components that logged console errors or warnings while rendering, with the messages; on older React Native versions, such as 0.74 and 0.76, it notes that the list can be incomplete. Refs change when a component remounts or the app reloads.

These commands use the same connection as profiling, described below. If a React DevTools window is connected to the app, close it and reload the app first.

## React Native performance profiling

To find out why an interaction renders slowly, record a React profile around it:

```bash
agent-device react-devtools profile start
agent-device fill 'id="catalog-search"' "tart" --delay-ms 100
agent-device react-devtools profile stop
```

`profile stop` saves the recording and prints a short diagnosis: how many commits React made, how long they took, how many went over the 16 ms frame budget (when any did), and the problems it found, worst first. If changed-prop inspection is interrupted after collection, you can still read the saved recording with `profile report` and `profile commit`. Each finding names a component, shows the evidence, and suggests a fix:

```text
React profile 8.3s: 8 commits, 1303ms rendering, 8 over 16ms (worst #6 188ms)
1. memo-defeated ContactRow: memo bypassed on 480/480 updates; new highlight (object) 480x, onSelect (function) 480x from ContactList -> wrap those props in useCallback/useMemo in ContactList
```

| Finding | Meaning |
| --- | --- |
| `slow-render` | The component's own render is expensive. |
| `memo-defeated` | A memoized component often re-renders because props change identity. |
| `parent-cascade` | The component often re-renders with unchanged props, state, and context when its owner renders. |
| `context-cascade` | Most of the component's renders come from context changes. |
| `effect-chain` | The component triggers a follow-up commit right after rendering, likely state set in an effect. |
| `render-storm` | One component commits many times per second. |
| `eager-mount` | Hundreds of instances of one component mount in a single commit. |
| `slow-commit` | A commit took three frames or more, and other findings leave most of it unexplained. |

To dig into a finding, use the saved profile:

```bash
agent-device react-devtools profile report ContactRow
agent-device react-devtools profile commit 6
agent-device react-devtools profile report
agent-device react-devtools profile commit
```

Without an argument, `report` lists components by self time with why they rendered, and `commit` lists the commits in order.

Profiling works with development builds of React Native 0.74 and later, including Expo, and is verified on Android emulators and iOS simulators. It connects to the app through the Metro dev server, so the app, Metro config, and Babel config need no changes. If several apps use the same dev server, pass `--app <bundle-id>`. If one app runs on several devices connected to the same dev server, pass `--metro-device <name>` with a device name the error lists. If the dev server is not the session's Metro server or `localhost:8081`, pass `--metro-port` and `--metro-host`.

Development builds render slower than release builds. Compare profiles of the same interaction before and after a change rather than reading the numbers as absolute.

Component inspection and profiling also work through `agent-device proxy` and on remote bridge sessions, where they use the Metro server next to the agent: the session's binding from `metro prepare`, or `--metro-host`/`--metro-port`. Metro accepts the debugger connection only from its own machine, so the bridge or `metroPublicBaseUrl` cannot carry it.

For React Native apps, overlays, Metro/Fast Refresh blockers, and routing to profiling or debugging evidence, start with `agent-device help react-native`. For slow-flow investigations, combine `help react-devtools` for the React profile with `help debugging` for log markers, network/audio evidence, traces, and perf samples.

React Native warning and error overlays come from the app. Treat them as findings or blockers: capture them, run `agent-device react-native dismiss-overlay` when the overlay is unrelated, then re-snapshot and report the overlay.

For permission prompts and other alerts already on screen, see [Wait and alerts](/docs/commands#wait-and-alerts).

## React Native JS memory through CDP

Use `cdp` when a React Native or Expo app exposes a Metro CDP target and you need JavaScript heap usage, heap snapshots, allocation hotspots, retained-object diffs, retaining paths, or a small runtime eval to confirm JS state.

```bash
agent-device cdp target list --url http://127.0.0.1:8081
agent-device cdp target select <target-id>
agent-device cdp memory usage sample --label baseline --gc
agent-device cdp memory snapshot capture --name baseline --gc
agent-device cdp memory snapshot diff --base ms_1 --compare ms_2 --limit 10
agent-device cdp memory snapshot leak-triplet --baseline ms_1 --action ms_2 --cleanup ms_3 --limit 10
agent-device cdp memory snapshot retainers --snapshot ms_3 --id <node-id> --depth 8 --limit 10
```

- `cdp` runs a pinned CDP helper through npm. The first run may download the package; later runs reuse the npm cache.
- Every argument after `cdp` is passed to the CDP helper. Put `agent-device` global flags before `cdp` when you need the outer CLI to consume them.
- In remote bridge sessions, run `connect` first and omit `--url` for `target list` or `target select`; `agent-device` derives the Metro CDP URL from the prepared remote runtime.
- Start with `memory usage sample --gc` for a quick JS heap growth signal. Use snapshot diff and `leak-triplet` for proof that objects stayed retained after cleanup.
- `cdp` has no single leak-report command. Build one from `memory usage diff`, `memory snapshot diff`, `memory snapshot leak-triplet`, and `memory snapshot retainers`.
- Keep raw heap snapshots and allocation exports as artifacts. Summarize heap deltas, top retained classes/shapes, leak-triplet rows that stayed high after cleanup, and shortest useful retaining paths.
- React Native/Hermes supports only part of browser CDP. If a method is unsupported, keep the selected target and fall back to heap usage samples plus heap snapshots.
- Prefer `perf cpu`, `trace`, `network`, `logs`, and `react-devtools` over `cdp profile cpu`, `trace`, `network`, and `console`.
- Use `perf memory sample` and `perf memory snapshot` for native/process memory. Use `cdp` only for JavaScript heap evidence.

## Capture a clean repro window

```bash
agent-device open MyApp --platform ios
agent-device logs clear --restart
agent-device logs mark "before repro"
agent-device press 'id="submit"'
agent-device network dump 25 --include headers
agent-device perf frames --json
agent-device perf memory sample --json
agent-device logs path
```

This flow gives you logs, recent network activity, and a quick metrics sample from the active app session, starting from an empty log.

`open` prints `Session state: <path>`. That directory holds the run's request diagnostics, Apple runner output, and app logs; see [Find a session's logs and artifacts](/docs/sessions#find-a-sessions-logs-and-artifacts).

When a command fails, use `--json` to inspect `error.details.stderr` when it is present. Diagnostic stderr is secret-redacted and retains up to 8,192 characters; longer output keeps its beginning and end with a truncation marker between them. Other diagnostic strings remain limited to 400 characters. Compact retry summaries may retain less output.

When a command fails against a remote daemon, the `Diagnostics Log:` path is always on your machine:
agent-device downloads the failing request's record over the same base URL and token into
`<state-dir>/remote-diagnostics/<session>/requests/<request-id>.ndjson`, so a CI job can keep it as a build
artifact. If the download fails, the line reads `unavailable` with the remote daemon, the
request id, and the reason — never a path on the daemon host.

On iOS simulators, `logs` scope by bundle id and the resolved app executable. For launch-time stdout/stderr, capture the direct app launch console instead of starting raw `simctl` streams:

```bash
agent-device open MyApp --platform ios --relaunch --launch-console ./artifacts/app.console.log
```

`--launch-console` is only for direct iOS simulator app launches, not URL opens.

## Crash symbolication

Pick the tool for what you need:

| Need                                                                          | Use             |
| ----------------------------------------------------------------------------- | --------------- |
| Lead-up timeline before a failure                                             | `logs`          |
| Failing frame from `crash.ips`/`crash.log` plus matching dSYM/build directory | `debug symbols` |
| Live state, breakpoints, variables, memory, or stepping                       | Xcode/LLDB      |

Use `debug symbols` when you already have an Apple crash artifact and local dSYMs and need the failing code path, not a full log dump:

```bash
agent-device debug symbols --artifact crash.log --dsym MyApp.dSYM --out crash-symbolicated.log
agent-device debug symbols --artifact crash.ips --search-path ./build --out crash-symbolicated.ips
```

The command supports Apple `.ips`, `.crash`, and log-style crash artifacts that contain Binary Images or IPS `usedImages`. It matches UUIDs from the crash artifact against `dwarfdump --uuid` output from `.dSYM` bundles, runs `atos`, writes a symbolicated artifact, and prints only the output path plus a compact crash report: app/thread, exception or termination, top symbolicated frames, and the first actionable frame finding. The full symbolicated artifact stays on disk, so agent context stays small.

`debug` covers symbolication only. Use `logs` for app logs, `network` for HTTP evidence, `perf` for performance samples, `record`/`trace` for media and traces, and `react-devtools` for React Native components and performance profiling. `debug symbols` does not handle Android Java/R8 `mapping.txt` or native `ndk-stack`/`addr2line` symbolication; capture Android crash evidence with `logs` and symbolicate it with other tools.

## Core commands

### Logs

```bash
agent-device logs start
agent-device logs stop
agent-device logs clear --restart
agent-device logs path
agent-device logs doctor
agent-device logs mark "before submit"
```

- Logging is off by default; turn it on only for focused debugging windows.
- Prefer `logs clear --restart` for clean repro loops.

#### Search app logs with grep

Run `logs path` to get the log file, then `grep` that path so only matching lines enter agent context:

```bash
# Prints the app log path, for example ~/.agent-device/sessions/default/app.log
agent-device logs path

# -n adds line numbers; -E allows | without escaping
grep -n "Error\|Exception\|Fatal" ~/.agent-device/sessions/default/app.log
grep -n -E "Error|Exception|Fatal|crash" ~/.agent-device/sessions/default/app.log
grep -n -E "agent-device.*mark|before submit" ~/.agent-device/sessions/default/app.log

# Last 50 lines only
tail -50 ~/.agent-device/sessions/default/app.log
```

- Replace the example path with the one `logs path` prints.
- Prefer targeted patterns (such as `Error`, `Exception`, or your own log tags) over reading the whole file.
- `logs mark "before submit"` writes a line prefixed with `[agent-device][mark][...]`, so grep for `agent-device.*mark` to find your timing markers.

### Network inspection

```bash
agent-device network dump 25
agent-device network dump 25 --include headers
agent-device network dump 25 --include all
```

- `network dump` parses recent HTTP(s) entries from the session app log for app/device sessions and from managed `agent-browser` request history for web sessions.
- For app/device sessions, results depend on what the app writes to the platform log.
- On Android, results include logcat timestamps, and status and duration can be filled in from adjacent GIBSDK packet lines when the URL is logged separately. Log streaming reattaches to the app's new process after a restart.
- On iOS simulators, logs stream from inside the simulator, and `network dump` reads recent simulator log history when the live window is sparse.
- On iOS, `network dump` can return zero entries for real traffic when the app does not log request metadata to Unified Logging. The response notes tell an empty repro window apart from a log window with no network lines.
- On iOS, the system logs a request URL only when it opens a connection. Requests that reuse a keep-alive connection are reported against that connection's origin with `pathUnavailable: true`, their status, and timing. Requests whose connection opened before the scanned window are only counted in `unnamedRequests`. Treat an endpoint missing from an iOS dump as unproven, not as never called.
- On web, request and response bodies are not available; use `agent-browser` HAR capture directly when you need them.
- On the BrowserStack and TestMu AI providers, `network dump` reports `network-capture-post-session` and refuses: those providers capture traffic through their own proxy and publish a HAR only after their session ends, which `disconnect` does and `close` alone does not. Start the session with `--provider-network-logs` and read the HAR from `artifacts` after `disconnect`. See [BrowserStack](/docs/browserstack) and [TestMu AI](/docs/testmu).
- For the alias and scan limits, see [Media and logs](/docs/commands#media-and-logs).

### Audio probes

```bash
agent-device audio probe start 10 1000 --platform web
agent-device audio probe status --platform web
agent-device audio probe stop --platform web
agent-device audio probe start 10 1000 --platform macos
agent-device audio probe start 10 1000 --platform ios
agent-device audio probe start 10 1000 --platform android
```

- `audio probe start [durationSeconds] [bucketMs]` samples live audio while the session keeps running and reports compact `rmsDbfs` and `peakDbfs` buckets. The first timing positional is seconds; the second is milliseconds.
- On web, the probe samples HTML media elements through Web Audio. URL-backed media may be routed through the probe `AudioContext` while observed.
- On macOS hosts, the probe samples host system audio through ScreenCaptureKit for macOS sessions, iOS simulators, and Android emulators. It requires Screen Recording permission and is system-audio evidence, not app-instrumented audio. Physical iOS and Android devices are not supported.
- Use `status` to poll partial buckets during a 10-20 second observation window, and `stop` to end the probe early.

### Performance snapshots

```bash
agent-device perf frames --json
agent-device perf memory sample --json
agent-device perf memory snapshot --kind android-hprof --out app.hprof
agent-device perf memory snapshot --kind memgraph --out app.memgraph
agent-device perf cpu profile start --kind xctrace --template "Time Profiler" --out app.trace
agent-device perf cpu profile stop --kind xctrace --out app.trace
agent-device perf cpu profile report --kind xctrace --out app-profile.json
agent-device perf cpu profile start --kind simpleperf --out cpu.perf.data
agent-device perf cpu profile stop --kind simpleperf --out cpu.perf.data
agent-device perf cpu profile report --kind simpleperf --out cpu-report.json
agent-device perf trace start --kind perfetto --out app.perfetto-trace
agent-device perf trace stop --kind perfetto --out app.perfetto-trace
```

- Name a `frames`, `memory`, `cpu`, or `trace` area. Bare `perf`, `perf sample`, `perf metrics`, and `metrics` fail with an error that names the replacement.
- `perf frames` returns a focused frame/jank-health payload.
- `perf memory sample` returns a compact memory-only payload. Prefer it over raw `dumpsys`/`leaks` output for a first pass: arrays stay bounded and the top consumers are listed compactly.
- Example sample shape: `{"metrics":{"memory":{"available":true,"totalPssKb":562958,"totalRssKb":570304,"topConsumers":[{"name":"Dalvik Heap","pssKb":213456}]}}}`.
- `perf memory snapshot` escalates to file artifacts. Android supports Java HPROF capture for active app processes when the build/device allows heap dumping. iOS simulator and macOS app sessions support memgraph capture. On physical iOS devices, memgraph capture reports unavailable with a hint.
- Heap and memgraph artifacts are returned as paths plus compact metadata. Example default output: `Memory artifact (android-hprof): /tmp/app.hprof (42MB)`. They are not printed or embedded in JSON by default. Native allocation tracing (heapprofd) is not supported.
- `perf cpu profile ... --kind xctrace` collects an Apple native `.trace`; `report` aggregates every run, returns at most ten weighted top functions in JSON, and prints five. `perf trace ... --kind xctrace` keeps trace data as an artifact.
- On iOS simulators and macOS, process sampling and captures target the resolved app executable. Other running copies with the same executable name are excluded, including copies installed on another simulator.
- Android native profiling uses `perf cpu profile ... --kind simpleperf`; its report likewise returns at most ten top functions and prints five. Android native trace capture uses `perf trace ... --kind perfetto`. These commands require an active Android app session and return artifact paths/summaries instead of dumping profile or trace contents.
- Use the compact result as evidence. For example, a successful Perfetto stop may return `state: "stopped"`, `outPath: "/tmp/app.perfetto-trace"`, `sizeBytes: 5392410`, and `method: "adb-shell-perfetto"` while the 5.3 MB raw trace remains on disk as the artifact.
- Memory and Android frame-health availability depend on platform and whether the active session is bound to an app/package. HarmonyOS reports process RSS through HDC; CPU profiling, frame sampling, and memory-snapshot artifacts remain unavailable on the public HDC surface.
- `open` returns app startup duration as `startup`.
- On Android and supported Apple targets, use `metrics.fps.droppedFramePercent` for the health check and `metrics.fps.worstWindows` to line up jank clusters with logs, network activity, or recent actions.
- Android frame health comes from `dumpsys gfxinfo <package> framestats` and memory from `dumpsys meminfo <package>`. Apple frame health comes from the xctrace Animation Hitches template, and memory from process RSS. Memory values are in kilobytes.
- Android frame health resets after each successful `perf frames` read and after `open <app>`. For a focused window, run `perf frames`, perform the interaction, then run `perf frames` again.
- On physical iOS devices, `perf frames` records a short xctrace sample. Keep the device unlocked and connected, with the app in the foreground.
- After an Android URL or deep-link `open`, including Expo Go and dev-client shells, agent-device tries to detect the foreground package. If the session still has no package, package-bound metrics stay unavailable until you run `open <app>`.
- The Simpleperf report artifact keeps up to 50 parsed rows.
- Without `--json`, each perf area prints a compact summary.

## Where to go deeper

- Full command reference: [Commands](/docs/commands)
- Node.js observability APIs: [Node.js API](/docs/client-api)
- Session behavior and lifecycle: [Sessions](/docs/sessions)
