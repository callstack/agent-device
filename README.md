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

## Fetch into a checkout

```sh
git fetch origin evidence/ios-snapshot
for f in ios-snapshot-cold-local-71fb2483f.json \
         ios-snapshot-warm-relaunch-local-71fb2483f.json \
         ios-snapshot-proxy-71fb2483f.json; do
  git show FETCH_HEAD:$f > scripts/ios-snapshot-benchmark/evidence/$f
done
shasum -a 256 scripts/ios-snapshot-benchmark/evidence/*.json
pnpm bench:ios-snapshot:evidence
```

## Add a new corpus

Commit new raw results on top of this branch with the message
`evidence(ios-snapshot): benchmark results measured at <commit>` and extend the table
above. Never rewrite history here: `main` cites these hashes.
