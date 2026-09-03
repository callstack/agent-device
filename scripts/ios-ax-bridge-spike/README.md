# iOS Simulator AX bridge spike

This bounded harness supplies the decision evidence for [#2192](https://github.com/callstack/agent-device/issues/2192). It compares an in-Simulator accessibility reader with the #2189 XCTest control baseline behind one acquisition adapter. It does not select a production backend or change daemon, runner, open, relaunch, proxy, interaction, or public CLI behavior, and nothing in it ships in the npm package.

## Mechanism under test

The guest candidate is idb v1.5.2's `Resources/SimulatorFrameworkBridge`: a 196 KB iOS-Simulator executable that reads the XCTest-shaped element tree (`XC_kAXXCAttribute*`) inside the Simulator and serves it over a UNIX socket. The spike drives it **directly from Node**:

- `xcrun simctl spawn <udid> SimulatorFrameworkBridge accessibility serve <socket> --idle-timeout 300 --exit-on-disconnect true` starts one private guest per session in the Simulator's launchd domain;
- the host connects to the socket and exchanges 4-byte big-endian length-prefixed JSON frames;
- each read is one `describe` with `snapshotTree=true` (one XCTest snapshot fetch, one Mach round trip) and `automationMode=true`, so the target exposes its accessibility server without preboot preference edits;
- a known target generation reads by pid; otherwise the guest resolves the foreground app in-guest through RunningBoard.

No `idb_companion`, gRPC, or Python client is involved. The earlier prototype packaging (companion + Python reader) is retained only as the superseded targeted artifact.

Build the repository first:

```sh
pnpm install --frozen-lockfile
pnpm build
```

Obtain the guest executable from the official arm64 [idb v1.5.2 release](https://github.com/facebook/idb/releases/tag/v1.5.2) (`idb-companion.macos-arm64.tar.gz`, SHA-256 `f17b718a513931705542a7fbfa9cfc11895ee191562c9ffd2343cf7f8254bc08`; the extracted `Resources/SimulatorFrameworkBridge` has SHA-256 `3545621d2dc98de32879ebac55e8b0c33dc8eb7cc2bfbc2d0d2d21a002c8de58`). Use a task-owned iOS Simulator with the test app installed.

## Broad corpus

```sh
pnpm bench:ios-ax-bridge -- \
  --udid SIMULATOR_UDID \
  --candidate guest-simulator-framework-bridge,xctest-control \
  --state cold-cold,cold,warm,relaunch \
  --screen quiet,list,nested-scroll,alert,system-surface,xctest-stress \
  --samples 20 \
  --guest-bridge /path/to/Resources/SimulatorFrameworkBridge \
  --out .tmp/ios-ax-bridge-spike.v1.json.gz
```

The default candidate set, state set, screen set, and sample minimums come from the #2189 benchmark definitions. Each request carries an optional expected target generation and fixed request, response, node-count, traversal-depth, CPU, memory, and duration bounds. Guest reads keep the nested view hierarchy as parent-linked raw nodes with XCTest type names, labels, values, identifiers, and frames; they do not import visibility, hittability, scope, depth, or semantic compaction. Every sample keeps resource metrics and target status; each cell keeps one raw-tree exemplar with viewport, lineage, truncation, residue, and bounded diagnostics, plus separate prototype presentation measurements.

Hard tiers follow the maintainer-corrected #2192 contract: warm p50 < 300 ms and p95 < 500 ms per screen, relaunch p95 < 500 ms after observed app readiness. The former 75/150 ms and 250 ms values are reported as stretch findings and never decide GO/NO-GO.

`--apply-preferences` optionally runs the task-owned preboot AX preference experiment. The Simulator must be shutdown; the harness records exact plist hashes and targeted key changes, then restores the original bytes before reporting. The keys are not production defaults and the guest path does not need them.

## Targeted evidence

The broad corpus predates the corrected hard-latency contract. The live nonresident-bootstrap and lifecycle evidence is produced with:

```sh
pnpm bench:ios-ax-bridge:targeted -- \
  --udid SIMULATOR_UDID \
  --guest-bridge /path/to/Resources/SimulatorFrameworkBridge
```

For each of five bootstrap samples the fixture app is relaunched, a throwaway probe bridge polls until the new app generation answers with a tree (readiness is observed, never assumed from a pid), the probe exits, and only then a fresh guest is spawned and timed to its first usable tree. Host load is recorded per sample. Recovery probes exercise process crash, timeout, cancellation, and a dead target generation through the same adapter and require a typed failure plus a usable recovered read. The run preserves the broad raw artifact, writes the narrow raw artifact, and regenerates the corrected report.

The harness fails closed. It reports `NO-GO` when the guest candidate is unsupported, unavailable, unreadable, stale, over a bound, below the sample minimum, or when crash/timeout/cancellation recovery is not typed and recovered. XCTest is a control result and cannot turn a passing guest corpus into a failure.
