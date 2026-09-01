# iOS snapshot convergence evidence

This harness owns the reproducible evidence contract for [#2189](https://github.com/callstack/agent-device/issues/2189), which supplies measurements to [#2188](https://github.com/callstack/agent-device/issues/2188). It does not change daemon, runner, snapshot, or package runtime behavior.

## Prepare a real target

Use a dedicated iOS Simulator and the checked-in test app. Build the CLI and app before measuring:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test-app:install
pnpm test-app:ios -- --device "bench-golden-v1"
```

The app build must succeed on the host. If signing, Xcode, XCTest, simulator, runner, or daemon setup cannot be made deterministic, stop and attach the exact command, target, toolchain, and diagnostic; do not report fixture-only timings.

## Local state matrix

Replace `SIMULATOR_UDID` with the dedicated simulator UDID. The default screen set is quiet, list, nested-scroll, alert, system-surface, and xctest-stress. Cold cells require at least 10 samples; warm and relaunch cells require at least 20.

```sh
pnpm bench:ios-snapshot -- \
  --mode local \
  --udid SIMULATOR_UDID \
  --state cold-cold,cold,warm,relaunch \
  --screen quiet,list,nested-scroll,alert,system-surface,xctest-stress \
  --samples 20 \
  --out .tmp/ios-snapshot-convergence.v1.json
```

The cells mean:

- `cold-cold`: simulator off, daemon off, derived runner data cleared before each sample.
- `cold`: simulator booted, daemon stopped, and app terminated before each sample.
- `warm`: app, daemon, runner, and target are prepared once; each sample is a fresh CLI snapshot.
- `relaunch`: the same prepared tooling is retained while each sample launches a new app process.

Every sample keeps daemon duration and fresh-process wall time separately, the first-tree status, response bytes, target generation, and typed failure details. The raw JSON is validated against `raw-result.schema.v1.json`; the adjacent Markdown is a human-readable summary.

Each local cell is admitted only after the simulator state, verified daemon identity, app process generation, and exact fixture anchor are checked. A mismatch stops the run with a typed cell-state or fixture-anchor reason. Derived data is cleared only below the benchmark-owned state directory.

When `--state-dir` is omitted, the harness allocates a fresh marker-owned root under the host temporary directory. A caller-supplied state directory must already be a real, marker-owned directory; the CLI never initializes ownership for an existing path. Any explicit `--derived-path` must remain below that root.

## Proxy matrix

The proxy mode starts the repository proxy, then inserts a local deterministic conditioner in front of it. It runs both a persistent Node client and a fresh-process CLI at RTT 0, 20, and 80 ms. Request and response body bytes, failures, bandwidth, packet-loss rate, and seed are retained in the raw result.

```sh
pnpm bench:ios-snapshot -- \
  --mode proxy \
  --udid SIMULATOR_UDID \
  --screen quiet \
  --rtt 0,20,80 \
  --samples 20 \
  --bandwidth-kbps unlimited \
  --packet-loss 0 \
  --out .tmp/ios-snapshot-proxy.v1.json
```

The conditioner is semantics-preserving at zero packet loss. Non-zero loss is an explicit failure experiment, not a successful baseline.

The reviewed exact-head warm/quiet outputs are retained under [`evidence/`](./evidence/):
`ios-snapshot-warm-quiet-local-e9b1fc523.json` and
`ios-snapshot-warm-quiet-proxy-e9b1fc523.json`, with adjacent Markdown summaries. Each JSON file
is the schema-validated raw result from the commit named in its `revision` field.

## Package-size evidence

`pnpm size --json .tmp/size.json --markdown .tmp/size.md` measures bundled JavaScript, packed tarball, packed unpacked tree, and the package tree after a clean `npm install` into an isolated consumer. The iOS harness includes those three package measurements unless `--skip-package-size` is supplied.

## Permanent deep-button control

This is an implementation-independent control for [#1626](https://github.com/callstack/agent-device/issues/1626): the checked-in `deep-button-fixture.v1.json` artifact contains a 72-level ancestor chain and independently recorded shallow/full outputs. The changed leaf is intentionally omitted by the shallow observation, so a no-effect assertion must fail. The full observation includes the leaf and passes.

```sh
pnpm bench:ios-snapshot:deep-button -- --rule invalid-shallow
# expected exit 1:
# AssertionError: changed descendant was omitted by shallow observation; no-effect claim is invalid.
pnpm bench:ios-snapshot:deep-button -- --rule safe-full
# expected exit 0
```

The schema links [#1571](https://github.com/callstack/agent-device/issues/1571) so an unreadable or empty first tree remains distinct from bridge, runner, timeout, stale-generation, packet-loss, and upstream failures. This harness does not modify either issue’s runtime behavior.
