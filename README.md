# iOS snapshot benchmark evidence

Orphan branch `evidence/ios-snapshot` of callstack/agent-device. It holds the raw
`pnpm bench:ios-snapshot` results measured at repository commit
`71fb2483f30d90e615e949601c836aeebbf450c5` on `bench-golden-v2` (iPhone 17 Pro, iOS 27.0).
The files are measurement output, not fixtures; the harness, the schema
(`scripts/ios-snapshot-benchmark/raw-result.schema.v1.json`), and the adjacent Markdown
summaries live on `main` under `scripts/ios-snapshot-benchmark/`.

| File | sha256 |
| --- | --- |
| `ios-snapshot-cold-local-71fb2483f.json` | `532a83247bfbf8ee47039f80ac429f067c84679e92c781768c1044da1ae6e9bf` |
| `ios-snapshot-warm-relaunch-local-71fb2483f.json` | `6d299e8baec69662dca2c1ad8f1348e4361d5afaa781080e9a6b9b3dac362cbf` |
| `ios-snapshot-proxy-71fb2483f.json` | `b11b7a07be9e4dcf003f3af66943682a6733c6f21f5f43d3d9e88b3fb37b51a7` |

## Simulator accessibility bridge decision evidence

These compressed artifacts support the Node-direct Simulator bridge decision measured at
repository commit `268a90275e7a30419e581336b6d85eff680a2eb6`. The broad corpus retains the
September 1 measurements; the targeted and corrected artifacts contain the clean rerun and
maintainer-corrected evaluation.

| File | sha256 |
| --- | --- |
| `ios-simulator-ax-bridge-broad-268a90275.json.gz` | `309f974b1dcb90768548a189f6af58b493b5d7b9d56a5bfad060d4335139eb7b` |
| `ios-simulator-ax-bridge-targeted-268a90275.json.gz` | `fa2e01dcb5e2a0229a6836f1a4187169445347dd4c0a42bcb5a29022538c70b2` |
| `ios-simulator-ax-bridge-corrected-268a90275.json.gz` | `4d70596a39153e6104e37a790622450d967f61b2244745915f39462514ba3bed` |

### Corrected relaunch corpus

These artifacts were captured at repository commit
`636b1deac98ab88cc8e0e1ed894b5719d8a6c83f`. They replace the targeted decision
artifact above with 20 Node-direct relaunch samples on each of six representative
screens. Every timed sample is paired with independently observed readiness for the
expected application process generation and screen anchor. The supplied idb guest
binary was verified against its pinned SHA-256 before capture.

| File | sha256 |
| --- | --- |
| `ios-simulator-ax-bridge-targeted-636b1deac.json.gz` | `092d3deab3753c1b7a0d230d9e54f703e5fedb87ffc0974f082541ba9b4e687d` |
| `ios-simulator-ax-bridge-corrected-636b1deac.json.gz` | `a20039b38d4da65fed65518a3214153afa0174faaf6fb38c3950a3bd1362870d` |

### Post-rebase final corpus

The final artifacts were recaptured at repository commit
`44995806ea3be09f3c48ceac50ac3cab18462c35` after rebasing the pull request onto
`941ca0e7e08f50960dc90d3fdafa572355b030a0`. They repeat the same bounded corpus
and supersede the preceding targeted artifacts for the pull-request decision.

| File | sha256 |
| --- | --- |
| `ios-simulator-ax-bridge-targeted-44995806ea.json.gz` | `3440d066cb7eea33c4715fece838b5185c5d209694b097e54f5536d48d4984ad` |
| `ios-simulator-ax-bridge-corrected-44995806ea.json.gz` | `0a34a84402e85154e177adef5122101b26bfd04d74714a0a9b6f0795270edc41` |

## Production routing acceptance (#2279)

[PR #2279 acceptance evidence](pr-2279/README.md) contains the matched six-screen
warm corpus at `ae26f7afc064c75c65c71e677d32d77cdf2f9709` against
`7a2d48d160aaacb582c6f4cde98b6af7531bf7af`, public responses, foreground fallback
proof, regression records, and checksums. The immutable tag is
`evidence/ios-snapshot/ae26f7afc0`. Timings are bounded observations under
uncontrolled host load, not a general performance guarantee.

## Convergence final corpus (#2188 gate)

Raw results closing the exact-head evidence sweep that gated #2188 on #2199, measured at
repository commit `7c434b575837e3291c51315bf9bb8b54c8ce7568` on `bench-2188-final`.
The cold and first-interaction legs carry 10 samples per cell, warm/relaunch 20, and the
proxy leg 20 per screen at each of 0, 20, and 80 ms of added RTT. Every leg completed with
`revision.dirty: false` and no failed samples. The package-size leg ran inside
`ios-snapshot-warm-relaunch-local-7c434b575.json`.

Deviations from the baseline corpus above, stated in full:

- Target and runtime: `bench-2188-final` on
  `com.apple.CoreSimulator.SimRuntime.iOS-26-2`. The baseline ran on `bench-golden-v2` with
  iOS 27.0, whose runtime was not installed on this host at measurement time.
- Host: same machine model, shared with other agent sessions. The 1-minute load average
  sampled during the legs was 4.2-31.2 for warm/relaunch, 6.4-30.3 for proxy, and 5.3-96.7
  for cold. Timings are bounded observations under uncontrolled host load, not a general
  performance guarantee.
- Fixture app: the CI-built `AgentDeviceTester` for this lineage with the measured head's own
  JavaScript bundle repacked in. Its trees differ from the baseline app (the catalog screen
  exposes 31 nodes here against 35 at the baseline), so response sizes are not comparable
  cell for cell.
- Harness: the measured head is one benchmark-only commit ahead of `45e4c594a1824fc8152c5cce41fe1fac50a91bf0`,
  which put a bounded anchor wait into the untimed setup admission. No `src/`, `packages/`,
  app, or CLI runtime file differs between the two commits.

| File | sha256 |
| --- | --- |
| `ios-snapshot-cold-local-7c434b575.json` | `4663897ee5104569ad54e2ac803c216b284280c1c70fd82a8b2cf7b675d8a8bd` |
| `ios-snapshot-first-interaction-local-7c434b575.json` | `87c686336f5581e3f18111e160cf7b733cd726b41e79ed6d8e5b53e2ab40c3fb` |
| `ios-snapshot-warm-relaunch-local-7c434b575.json` | `d49df3c3c943178f016a2b958449b257c6d46a44c8ffdf8fab75c1634ae1ebce` |
| `ios-snapshot-proxy-7c434b575.json` | `5b5353831851f3a0f60e19d6bfd0cf50db47c3c4db52a283024c10bb17e71573` |

## Fetch into a checkout

```sh
git fetch origin evidence/ios-snapshot
for f in ios-snapshot-cold-local-71fb2483f.json \
         ios-snapshot-warm-relaunch-local-71fb2483f.json \
         ios-snapshot-proxy-71fb2483f.json \
         ios-snapshot-cold-local-7c434b575.json \
         ios-snapshot-first-interaction-local-7c434b575.json \
         ios-snapshot-warm-relaunch-local-7c434b575.json \
         ios-snapshot-proxy-7c434b575.json; do
  git show FETCH_HEAD:$f > scripts/ios-snapshot-benchmark/evidence/$f
done
shasum -a 256 scripts/ios-snapshot-benchmark/evidence/*.json
pnpm bench:ios-snapshot:evidence
```

## Add a new corpus

Commit new raw results on top of this branch with the message
`evidence(ios-snapshot): benchmark results measured at <commit>` and extend the table
above. Never rewrite history here: `main` cites these hashes.
