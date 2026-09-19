# Change-coupling report

```sh
pnpm coupling                                   # -> .tmp/coupling/report.json + a text summary
pnpm coupling --since-days 30 --out /tmp/coupling.json
pnpm coupling:test
```

Logical coupling from git history alone: do the physical families (workspace packages and
`src/` zones) match how the repository actually changes? There is no renderer; the JSON is the
artifact and the text summary is the headline.

## What it answers

- **Affinity.** A commit touching `k >= 2` production files adds `1 / (k - 1)` to each unordered
  pair; `support` counts the commits containing the pair. Commits over 60 files are mass
  migrations and are skipped and listed, never folded in. Edges below support 3 are cut.
- **Family modularity.** With `W` the kept weight, `in_f` the weight inside family `f`, `out_f`
  the weight leaving it, and `s_f = 2·in_f + out_f`: `intraShare = Σ in_f / W`,
  `expected = Σ (s_f / 2W)²`, `Q_f = in_f / W − (s_f / 2W)²`. `Σ Q_f = intraShare − expected`,
  asserted in `modularity.test.ts`. `expected` is what a size-matched random rewiring would keep
  inside families; the difference is what the families hold beyond their size.
- **Family span.** Distinct families per commit: histogram, median over commits spanning at
  least two families, and the share spanning five or more.
- Everything is computed twice, over all history and over the trailing window (`--since-days`,
  default 120), so drift is visible in one document.

## What the numbers do not mean

**This is not a removability or correctness claim.** Co-change says two files were edited in the
same commits; it does not say either imports the other, that one could move, or that anything
is wrong. A file with a high hub weight is a place to look, never a work list. In particular:

- `Q_f ≈ 0` with a large `out/in` flow says a family's changes land together with other
  families' changes. Whether that is a toolbox (`host-kit`), a vocabulary (`contracts`), or a
  wrongly-drawn boundary (`cli-schema`) is a reading the report cannot make for you.
- A high `Q_f` says a family's changes stay inside it. `daemon-server` scores highest partly
  because it is the largest family; the `expected` term corrects for size only in aggregate.
- The mass-commit threshold is a declared cut, not a detector. A 59-file refactor still counts.
- The trailing window is only as good as the commits in it; a 30-day window on a quiet month is
  a coin toss.

## Reference values (2026-09-19, commit a556e114cd)

| | all-time | last 120 days |
| --- | --- | --- |
| commits used for pairs / skipped (> 60 files) | 1,044 / 34 | 779 / 31 |
| kept edges at support ≥ 3 | 6,314 | 5,297 |
| cross-family share of kept edges | 64.3% | 62.5% |
| intraShare vs expected | 36.5% vs 11.5% | 39.7% vs 11.6% |
| modularity | 0.250 | 0.282 |
| median span of multi-family commits | 4 | 4 |
| multi-family commits spanning ≥ 5 families | 37.6% | 39.6% |

Heaviest hubs by out-family weight: `src/cli-schema/command-schema.ts` (96.5, reaches 22
families), `src/client/client-types.ts` (89.2, 26), `src/cli-schema/cli-help.ts` (85.7, 26),
`src/cli.ts` (72.2, 21). Heaviest family pairs: `commands <-> daemon-server` (60.6),
`cli-schema <-> daemon-server` (57.0), `daemon-server <-> platform-apple` (52.0).

A drift warning is printed, never a failure, when all-time modularity leaves 0.20–0.35, the
cross-family share drops under 60%, or the ≥ 5-family share drops under 25%.

## What is authoritative

`scripts/layering/` is, for the file set and the family partition: families are
`targetDagZone` from `scripts/layering/model.ts` and the file set is `listSourceFiles`, exactly as
`pnpm check:layering` sees them. History comes from `scripts/repo-history/`, the same model the
legibility report reads, so both reports describe one tree. Nothing here gates, ratchets, or
allowlists; the `coupling:test` gate proves the formulas on the committed fixture mini-repo in
`scripts/repo-history/__fixtures__/`, not the live numbers.

## What the JSON carries

- `generated` — commit, date, file and family counts.
- `window.allTime` / `window.since` — commit counts (total, touching, used, skipped, threshold),
  the skipped commits, edge counts with the cross-family share, and the span histogram.
- `assortativity` — `intraShare`, `expected`, `modularity` for both windows.
- `perFamily[]` — `family, files, inWeight, outWeight, outInFlow, partners, Q` (all-time).
- `hubs[]` — top files by kept weight with out-family weight and families reached.
- `familyPairs[]` — cross-family weight per unordered family pair.
- `edges[]` — every kept edge, `{ a, b, weight, support }`.
