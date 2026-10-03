# iOS snapshot benchmark evidence

The raw `pnpm bench:ios-snapshot` results live on the orphan branch `evidence/ios-snapshot`, not in
this tree. The branch tip is mutable; the durable refs are the annotated tags and full commits
below — fetch from those, never from the branch tip. Only Markdown summaries are kept here. The
published hashes are declared in [`../evidence.ts`](../evidence.ts) as `PUBLISHED_CORPORA`, and
[`../evidence.ts`](../evidence.ts) derives `PUBLISHED_EVIDENCE` from them.

## Baseline corpus — `71fb2483f`

Measured at commit `71fb2483f30d90e615e949601c836aeebbf450c5` on `bench-golden-v2` (iPhone 17 Pro,
iOS 27.0). Tag `refs/tags/evidence/ios-snapshot/71fb2483f`, commit
`2d4baf461aa8897d49c6d4683cd16d8f43588ae8`.

| File | sha256 |
| --- | --- |
| `ios-snapshot-cold-local-71fb2483f.json` | `532a83247bfbf8ee47039f80ac429f067c84679e92c781768c1044da1ae6e9bf` |
| `ios-snapshot-warm-relaunch-local-71fb2483f.json` | `6d299e8baec69662dca2c1ad8f1348e4361d5afaa781080e9a6b9b3dac362cbf` |
| `ios-snapshot-proxy-71fb2483f.json` | `b11b7a07be9e4dcf003f3af66943682a6733c6f21f5f43d3d9e88b3fb37b51a7` |

## Convergence final corpus — `7c434b575`

Measured at commit `7c434b575837e3291c51315bf9bb8b54c8ce7568` on `bench-2188-final` (iPhone 17 Pro,
iOS 26.2). Tag `refs/tags/evidence/ios-snapshot/7c434b575`, commit
`96d4951c19fbe009ba19d192a9774668edcc3f56`. This is the corpus that closed the evidence sweep
gating #2188 on #2199; [`../../../docs/evidence/ios-snapshot-convergence-final-2026-09-21.md`](../../../docs/evidence/ios-snapshot-convergence-final-2026-09-21.md)
reads it against the baseline, including the target, runtime, host-load, app, and harness
deviations between the two corpora.

| File | sha256 |
| --- | --- |
| `ios-snapshot-cold-local-7c434b575.json` | `4663897ee5104569ad54e2ac803c216b284280c1c70fd82a8b2cf7b675d8a8bd` |
| `ios-snapshot-first-interaction-local-7c434b575.json` | `87c686336f5581e3f18111e160cf7b733cd726b41e79ed6d8e5b53e2ab40c3fb` |
| `ios-snapshot-warm-relaunch-local-7c434b575.json` | `d49df3c3c943178f016a2b958449b257c6d46a44c8ffdf8fab75c1634ae1ebce` |
| `ios-snapshot-proxy-7c434b575.json` | `5b5353831851f3a0f60e19d6bfd0cf50db47c3c4db52a283024c10bb17e71573` |

## Fetch

One file, from the repository root:

```sh
git fetch origin refs/tags/evidence/ios-snapshot/7c434b575 && git show 96d4951c19fbe009ba19d192a9774668edcc3f56:<file> > scripts/ios-snapshot-benchmark/evidence/<file>
```

The whole corpus, then a schema and hash check:

```sh
git fetch origin refs/tags/evidence/ios-snapshot/71fb2483f
for f in ios-snapshot-cold-local-71fb2483f.json \
         ios-snapshot-warm-relaunch-local-71fb2483f.json \
         ios-snapshot-proxy-71fb2483f.json; do
  git show 2d4baf461aa8897d49c6d4683cd16d8f43588ae8:$f > scripts/ios-snapshot-benchmark/evidence/$f
done
git fetch origin refs/tags/evidence/ios-snapshot/7c434b575
for f in ios-snapshot-cold-local-7c434b575.json \
         ios-snapshot-first-interaction-local-7c434b575.json \
         ios-snapshot-warm-relaunch-local-7c434b575.json \
         ios-snapshot-proxy-7c434b575.json; do
  git show 96d4951c19fbe009ba19d192a9774668edcc3f56:$f > scripts/ios-snapshot-benchmark/evidence/$f
done
pnpm bench:ios-snapshot:evidence
```

`pnpm bench:ios-snapshot:evidence -- --evidence-dir <dir>` checks another directory, for example
a fresh `--out` location. The fetched JSON files are ignored by git under this directory.
