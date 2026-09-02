# iOS Simulator AX bridge spike

This bounded harness supplies the decision evidence for [#2192](https://github.com/callstack/agent-device/issues/2192). It compares the official idb `SimulatorFrameworkBridge` guest mechanism with the #2189 XCTest control baseline behind one acquisition adapter. It does not select a production backend or change daemon, runner, open, relaunch, proxy, interaction, or public CLI behavior.

Build the repository first:

```sh
pnpm install --frozen-lockfile
pnpm build
```

Use a newly created, task-owned iOS Simulator. The guest candidate uses the arm64 [idb release](https://github.com/facebook/idb/releases/tag/v1.5.2) outside this repository:

```sh
pnpm bench:ios-ax-bridge -- \
  --udid SIMULATOR_UDID \
  --candidate guest-simulator-framework-bridge,xctest-control \
  --state cold-cold,cold,warm,relaunch \
  --screen quiet,list,nested-scroll,alert,system-surface,xctest-stress \
  --samples 20 \
  --apply-preferences \
  --guest-companion /path/to/idb_companion \
  --guest-python python3 \
  --guest-site-packages /path/to/idb-cli/libexec/lib/python3.14/site-packages \
  --out .tmp/ios-ax-bridge-spike.v1.json.gz
```

The default candidate set, state set, screen set, and sample minimums come from the #2189 benchmark definitions. Each request carries an optional expected target generation and fixed request, response, node-count, traversal-depth, CPU, memory, and duration bounds. The guest adapter uses a newline-delimited reader, keeping one idb gRPC client and one `axbridge-persistent` reader alive across the run. Guest reads request idb's flat raw element form, preserving provider facts without importing visibility, hittability, scope, depth, or semantic compaction. Every sample keeps resource metrics and target status; each cell keeps one raw-tree exemplar with viewport, lineage, truncation, residue, and bounded diagnostics, plus separate prototype presentation measurements.

`--apply-preferences` is the only way the experiment edits Simulator preference plists. The Simulator must be shutdown; the harness records exact plist hashes and targeted key changes, then restores the original bytes before reporting. The keys are not production defaults.

The harness fails closed. It reports `NO-GO` when the guest candidate is unsupported, unavailable, unreadable, stale, over a bound, below the sample minimum, or when crash/timeout/cancellation recovery is not typed and recovered. XCTest is a control result and cannot turn a passing guest corpus into a failure. It stops before reporting timings if the fixture app cannot be prepared deterministically. The adjacent gzipped JSON and readable Markdown report are the decision artifact; no production route should be implemented from a `NO-GO` run.

The checked-in broad corpus predates the corrected hard-latency contract. Reproduce only the
missing live bootstrap and lifecycle evidence with:

```sh
pnpm bench:ios-ax-bridge:targeted -- \
  --udid SIMULATOR_UDID \
  --apply-preferences \
  --guest-companion /path/to/idb_companion \
  --guest-python python3 \
  --guest-site-packages /path/to/idb-cli/libexec/lib/python3.14/site-packages
```

This preserves the broad raw artifact and writes a narrow raw artifact plus the superseding
corrected report. Each nonresident bootstrap sample re-establishes a booted Simulator and ready app
before its timer, so helper teardown contention and Simulator/app readiness are outside the measured
candidate boundary. Missing provider generation is emitted as typed residue; the reader never echoes
an expected generation it did not observe.
