# iOS Simulator AX bridge spike

This bounded harness supplies the decision evidence for [#2192](https://github.com/callstack/agent-device/issues/2192). It compares host-side public macOS AX, an explicitly configured private CoreSimulator AX tool, and the #2189 XCTest control baseline behind one framed acquisition adapter. It does not select a production backend or change daemon, runner, open, relaunch, proxy, interaction, or public CLI behavior.

Build the repository and the macOS helper first:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm build:ios-ax-bridge-spike
```

Use a newly created, task-owned iOS Simulator. Xcode 27 hosts should target the DeviceHub process explicitly when using the public candidate:

```sh
pnpm bench:ios-ax-bridge -- \
  --udid SIMULATOR_UDID \
  --target-process-id DEVICEHUB_PID \
  --candidate public-macos-ax,private-coresimulator-ax,xctest-control \
  --state cold-cold,cold,warm,relaunch \
  --screen quiet,list,nested-scroll,alert,system-surface,xctest-stress \
  --samples 20 \
  --apply-preferences \
  --out .tmp/ios-ax-bridge-spike.v1.json.gz
```

The default candidate set, state set, screen set, and sample minimums come from the #2189 benchmark definitions. Each request carries a target generation and fixed request, response, node-count, traversal-depth, CPU, memory, and duration bounds. The native helper sends one newline-delimited response per request and writes diagnostics to stderr only. The report keeps raw nodes, viewport evidence, target lineage, truncation, residue, resource metrics, stderr, and a separate prototype presentation measurement.

`--apply-preferences` is the only way the experiment edits Simulator preference plists. The Simulator must be shutdown; the harness records exact plist hashes and targeted key changes, then restores the original bytes before reporting. The keys are not production defaults. Omit `--private-tool` unless a disposable, compatible private mechanism is being tested; the harness never invents a private fallback.

The harness fails closed. It reports `NO-GO` when a candidate is unsupported, unavailable, unreadable, stale, over a bound, below the sample minimum, or when crash/timeout/cancellation recovery is not typed and recovered. It stops before reporting timings if the fixture app cannot be prepared deterministically. The adjacent gzipped JSON and readable Markdown report are the decision artifact; no production route should be implemented from a `NO-GO` run.
