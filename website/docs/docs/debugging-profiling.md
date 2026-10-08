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

## React Native component internals

To inspect the React Native component tree, props, state, hooks, or render profiling, use `react-devtools`:

```bash
agent-device react-devtools status
agent-device react-devtools wait --connected
agent-device react-devtools get tree --depth 3
agent-device react-devtools get component @c5
agent-device react-devtools profile start
agent-device react-devtools profile stop
agent-device react-devtools profile slow --limit 5
agent-device react-devtools profile rerenders --limit 5
agent-device react-devtools profile timeline --limit 20
agent-device react-devtools profile report @c5
```

`react-devtools` runs a pinned version of `agent-react-devtools` and passes your arguments to it.

For React Native apps, overlays, Metro/Fast Refresh blockers, and routing to React DevTools or debugging evidence, start with `agent-device help react-native`. For slow-flow investigations, combine `help react-devtools` for the narrow React profile window with `help debugging` for log markers, network/audio evidence, traces, and perf samples. Start with one bounded survey: the `profile stop` summary, the `slow` and `rerenders` tables with a `--limit`, and `timeline` only when commit timing matters. Then drill into a specific `@c` ref with `profile report` instead of raising the `profile slow` limit again and again.

React Native warning and error overlays come from the app. Treat them as findings or blockers: capture them, check `react-devtools errors` when connected, run `agent-device react-native dismiss-overlay` when the overlay is unrelated, then re-snapshot and report the overlay.

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

`debug` covers symbolication only. Use `logs` for app logs, `network` for HTTP evidence, `perf` for performance samples, `record`/`trace` for media and traces, and `react-devtools` for React Native internals. `debug symbols` does not handle Android Java/R8 `mapping.txt` or native `ndk-stack`/`addr2line` symbolication; capture Android crash evidence with `logs` and symbolicate it with other tools.

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
- For the alias and per-platform limits, see [Media and logs](/docs/commands#media-and-logs).

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

## Where to go deeper

- Full command reference: [Commands](/docs/commands)
- Node.js observability APIs: [Node.js API](/docs/client-api)
- Session behavior and lifecycle: [Sessions](/docs/sessions)
