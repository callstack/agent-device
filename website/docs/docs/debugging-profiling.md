---
title: Debugging & Profiling
---

# Debugging & Profiling

Use `agent-device` when the task moves past UI automation and you need runtime evidence from the app or device layer.

## What `agent-device` covers well

- Session app logs for targeted debugging windows
- Network inspection from recent HTTP(s) entries in app logs via `network dump`
- Performance snapshots with `perf metrics` / `perf frames`
- Apple crash symbolication with `debug symbols`
- Screenshots, recordings, and replayable repro flows

## React Native component internals

If the task needs the React Native component tree, props, state, hooks, or render profiling, use the `react-devtools` passthrough:

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

`agent-device` remains centered on the device and app runtime layer. The `react-devtools` command dynamically runs pinned `agent-react-devtools` commands for React internals.

For React Native apps, overlays, Metro/Fast Refresh blockers, and routing to React DevTools or debugging evidence, start with `agent-device help react-native`. For slow-flow investigations, combine `help react-devtools` for the narrow React profile window with `help debugging` for log markers, network evidence, traces, and perf samples. Make one bounded first-pass survey with the `profile stop` summary, bounded `slow` and `rerenders` tables, and `timeline` only when commit timing matters; then drill into a specific `@c` ref with `profile report` instead of repeatedly raising broad `profile slow` limits.

React Native warning/error overlays belong to the app run. Treat them as findings or blockers: capture them, check `react-devtools errors` when connected, run `agent-device react-native dismiss-overlay` when the overlay is unrelated, then re-snapshot and report the overlay.

Use `alert wait`, `alert accept`, and `alert dismiss` for Android runtime permission prompts, Android native alerts, and iOS platform/app-owned modal dialogs. Do not use `settings permission` to answer a dialog already on screen. Reserve `settings permission` for setup or resetting permission state before a flow.

## React Native JS memory through CDP

Use `cdp` when a React Native or Expo app exposes a Metro CDP target and the task needs JavaScript heap usage, heap snapshots, allocation hotspots, retained-object diffs, retaining paths, or a small runtime eval to confirm JS state.

```bash
agent-device cdp target list --url http://127.0.0.1:8081
agent-device cdp target select <target-id>
agent-device cdp memory usage sample --label baseline --gc
agent-device cdp memory snapshot capture --name baseline --gc
agent-device cdp memory snapshot diff --base ms_1 --compare ms_2 --limit 10
agent-device cdp memory snapshot leak-triplet --baseline ms_1 --action ms_2 --cleanup ms_3 --limit 10
agent-device cdp memory snapshot retainers --snapshot ms_3 --id <node-id> --depth 8 --limit 10
```

- `cdp` dynamically runs a pinned CDP helper through npm; the first run may download the pinned package, and later runs can reuse the npm cache.
- Every argument after `cdp` is passed to the CDP helper. Put `agent-device` global flags before `cdp` when you need the outer CLI to consume them.
- In remote bridge sessions, run `connect` first and omit `--url` for `target list` or `target select`; `agent-device` derives the Metro CDP URL from the prepared remote runtime.
- Start with `memory usage sample --gc` for a quick JS heap growth signal. Use snapshot diff and `leak-triplet` for proof that objects stayed retained after cleanup.
- Until `cdp` has a compact leak report command, synthesize one from `memory usage diff`, `memory snapshot diff`, `memory snapshot leak-triplet`, and `memory snapshot retainers`.
- Keep raw heap snapshots and allocation exports as artifacts. Default answers should summarize heap deltas, top retained classes/shapes, leak-triplet rows that stayed high after cleanup, and shortest useful retaining paths.
- React Native/Hermes supports only part of browser CDP. If a method is unsupported, keep the selected target and fall back to heap usage samples plus heap snapshots.
- Avoid `cdp profile cpu`, `trace`, `network`, and `console` by default because `agent-device` already has `perf cpu`, `trace`, `network`, `logs`, and `react-devtools` guidance for those areas.
- Use `perf memory sample` and `perf memory snapshot` for native/process memory. Use `cdp` only for JavaScript heap evidence.

## Fast path

```bash
agent-device open MyApp --platform ios
agent-device logs clear --restart
agent-device logs mark "before repro"
agent-device press 'id="submit"'
agent-device network dump 25 --include headers
agent-device perf metrics --json
agent-device logs path
```

Use this flow when you need a clean repro window with logs, recent network activity, and a quick metrics sample from the active app session.

`open` prints `Session state: <path>`. Inspect that directory for per-run artifacts: `requests/<request-id>.ndjson` contains daemon request diagnostics, `runner.log` contains Apple runner/`xcodebuild` output, and `app.log` contains app/device logs when log capture is active. The top-level daemon log is for daemon lifecycle/startup issues.

On iOS simulators, `logs` scope by bundle id and the resolved app executable. For launch-time stdout/stderr, capture the direct app launch console instead of starting raw `simctl` streams:

```bash
agent-device open MyApp --platform ios --relaunch --launch-console ./artifacts/app.console.log
```

`--launch-console` is only for direct iOS simulator app launches, not URL opens.

## Crash symbolication

Crash routing:

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

The command supports Apple `.ips`, `.crash`, and log-style crash artifacts that contain Binary Images or IPS `usedImages`. It matches UUIDs from the crash artifact against `dwarfdump --uuid` output from `.dSYM` bundles, runs `atos`, writes a symbolicated artifact, and prints only the output path plus a compact crash report: app/thread, exception or termination, top symbolicated frames, and the first actionable frame finding. This is better than pasting raw crash logs because it keeps agent context small while preserving the full symbolicated artifact on disk.

`debug` is intentionally narrow. Use `logs` for app logs, `network` for HTTP evidence, `perf` for performance samples, `record`/`trace` for media and traces, and `react-devtools` for React Native internals. Android Java/R8 `mapping.txt` and native `ndk-stack`/`addr2line` symbolication are deferred; capture Android crash evidence with `logs` and symbolicate externally for now.

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

- Logging is off by default; enable it only for focused debugging windows.
- Prefer `logs clear --restart` for clean repro loops.
- Use `logs path` and then grep the file instead of loading whole logs into agent context.

### Network inspection

```bash
agent-device network dump 25
agent-device network dump 25 --include headers
agent-device network dump 25 --include all
```

- `network dump` parses recent HTTP(s) entries from the session app log for app/device sessions and from managed `agent-browser` request history for web sessions.
- `network log` is an alias for `network dump`.
- Parsed results depend on what the app emits into the platform log backend.
- Web `network dump` includes request and response headers when requested, but the current `agent-browser network requests` backend does not expose request or response bodies.

### Performance snapshots

```bash
agent-device perf --json
agent-device metrics --json
agent-device perf metrics --json
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

- `perf metrics` returns session-scoped startup and, where supported, CPU, memory, and frame-health samples. Bare `perf` and `metrics` remain aliases.
- `perf frames` returns a focused frame/jank-health payload.
- `perf memory sample` returns a compact memory-only payload, preserving the memory metric source used by `perf metrics`. Prefer it over raw `dumpsys`/`leaks` output for first-pass agent diagnosis because it keeps arrays bounded, reports top offenders compactly, and omits unrelated startup/CPU/frame data.
- Example sample shape: `{"metrics":{"memory":{"available":true,"totalPssKb":562958,"totalRssKb":570304,"topConsumers":[{"name":"Dalvik Heap","pssKb":213456}]}}}`.
- `perf memory snapshot` escalates to file artifacts. Android supports Java HPROF capture for active app processes when the build/device allows heap dumping. iOS simulator and macOS app sessions support memgraph capture through host-visible process tooling; physical iOS device memgraph capture reports unavailable with a hint instead of pretending support.
- For React Native JavaScript heap leaks, use `agent-device cdp` against the Metro CDP target instead of native/process memory samples; see the CDP section above.
- Heap and memgraph artifacts are returned as paths plus compact metadata. Example default output: `Memory artifact (android-hprof): /tmp/app.hprof (42MB)`. They are not printed or embedded in JSON by default. heapprofd/native allocation tracing is deferred until Perfetto plumbing is available.
- `perf cpu profile ... --kind xctrace` and `perf trace ... --kind xctrace` collect Apple native `.trace` artifacts for iOS/macOS app sessions and return only artifact paths plus compact metadata.
- Android native profiling uses `perf cpu profile ... --kind simpleperf`; Android native trace capture uses `perf trace ... --kind perfetto`. These commands require an active Android app session and return artifact paths/summaries instead of dumping profile or trace contents.
- Use the compact native perf result as agent evidence. For example, a successful Perfetto stop may return `state: "stopped"`, `outPath: "/tmp/app.perfetto-trace"`, `sizeBytes: 5392410`, and `method: "adb-shell-perfetto"` while the 5.3 MB raw trace remains on disk as the artifact.
- Startup is measured around the `open` command; it is not first-frame instrumentation.
- CPU, memory, and Android frame-health availability depend on platform and whether the active session is bound to an app/package.
- On Android and supported Apple targets, use `metrics.fps.droppedFramePercent` for the health check and `metrics.fps.worstWindows` to line up jank clusters with logs, network activity, or recent actions.

## Where to go deeper

- Full command reference: [Commands](/docs/commands)
- Typed client observability APIs: [Typed Client](/docs/client-api)
- Session behavior and lifecycle: [Sessions](/docs/sessions)
