# iOS snapshot convergence final-head evidence

- Issues: #2188 (gate), #2199 (measurement), #2189 (baseline corpus), #1571/#1626 (corpus lineage)
- Observed: 2026-09-21, 19:03–22:52 CEST (legs sequential, one subprocess-backed gate per host)
- Revision: `7c434b5758` (`docs/ios-snapshot-final-evidence`, clean tree at every leg; `revision.dirty: false`)
- Target: `bench-2188-final` iPhone 17 Pro Simulator, iOS 26.2, UDID `5FEADD02-98E4-4F01-861C-07003C1A3291`
- Host: MacBook Pro `Mac16,8`, Apple M4 Pro, 12 cores, Xcode 26.2 (17C52), Node v26.8.1
- App: `Agent Device Tester` (`com.callstack.agentdevicelab`) from the CI artifact
  `fingerprint.d6b4c1f5e022e54074df584e332d1e0f100c7a0f.ios` (run `35530285864`), repacked with the
  measured head's own JavaScript bundle
- Corpora: tag `evidence/ios-snapshot/7c434b575`, evidence commit `96d4951c19`, four files listed
  with their SHA-256 digests in [`scripts/ios-snapshot-benchmark/evidence/README.md`](../../scripts/ios-snapshot-benchmark/evidence/README.md)
- Baseline: tag `evidence/ios-snapshot/71fb2483f`, evidence commit `2d4baf461aa`, measured at
  `71fb2483f3` on `bench-golden-v2` (iOS 27.0)

## What this closes

#2188 was gated on #2199's final exact-head evidence sweep: the package-size delta against #2189, the
conformance/fuzz/property corpus, provider contracts, the Simulator and proxy legs, the no-regrowth
enforcement, and a release record at a named head. All of it now exists at `7c434b5758`.

The proxy leg was the last blocker, and it was blocked by the harness, not by the product. The
anchor admission the harness gained at `71fb2483f3` reads the tree exactly once after `apps.open`.
On this target the first tree lands later than that read: the snapshot taken immediately after an
`open --relaunch --launch-url` returns the single `Application` node, while a read 1.5 s later
returns 31 nodes with the `Catalog` anchor. Every deep-linked screen the leg reached stopped with
`fixture-anchor`. `45e4c594a1..7c434b5758` puts a bounded wait into that untimed setup admission
(`FIXTURE_ANCHOR_ADMISSION_BUDGET_MS`, 30 s, 500 ms polling) and keeps the same typed stop when a
fixture never exposes its anchor. No `src/`, `packages/`, app, or CLI runtime file differs between
those two commits; the measured binary is the measured head's own `pnpm build` output.

## Deviations from the baseline corpus

Stated in full, because they bound what these numbers can prove.

| Deviation | This corpus | Baseline corpus |
| --- | --- | --- |
| Simulator and runtime | `bench-2188-final`, iOS 26.2 | `bench-golden-v2`, iOS 27.0 |
| Why | `bench-golden-v2`'s iOS 27.0 runtime was not installed on this host at measurement time | — |
| Host load (1-min average, sampled per leg) | warm/relaunch 4.2–31.2, proxy 6.4–30.3, cold 5.3–96.7 | quiet |
| Fixture app trees | catalog 31 nodes, nested-scroll 23, checkout 25, alert 26, Settings 18, inert 4 | catalog 35, nested-scroll 25, checkout 29, alert 28, Settings 18, inert 6 |
| Package-size span | `71fb2483f3..7c434b5758`: 196 commits of unrelated product work | — |

Because the fixture trees differ, response sizes are not comparable cell for cell, and any timing
delta on a screen whose tree changed is only partly attributable to the tooling. Timings are bounded
observations under uncontrolled host load, not a general performance guarantee.

## Result — cold and cold-cold (10 samples per cell, fresh CLI process)

| State | Screen | Wall median | Wall median (base) | Daemon median | Daemon median (base) |
| --- | --- | ---: | ---: | ---: | ---: |
| cold-cold | quiet | 7,159 | 17,544 | 5,709 | 15,161 |
| cold-cold | list | 7,580 | 19,170 | 5,881 | 17,191 |
| cold-cold | nested-scroll | 8,091 | 19,407 | 6,374 | 17,773 |
| cold-cold | alert | 7,461 | 19,448 | 5,689 | 17,436 |
| cold-cold | system-surface | 6,553 | 20,235 | 4,961 | 17,974 |
| cold-cold | xctest-stress | 7,273 | 20,811 | 5,761 | 18,506 |
| cold | quiet | 5,743 | 6,643 | 4,409 | 5,886 |
| cold | list | 5,847 | 6,851 | 4,420 | 5,897 |
| cold | nested-scroll | 6,058 | 6,713 | 4,619 | 5,884 |
| cold | alert | 5,706 | 6,674 | 4,310 | 5,868 |
| cold | system-surface | 5,028 | 6,819 | 3,662 | 5,957 |
| cold | xctest-stress | 5,679 | 6,714 | 4,323 | 5,874 |

Milliseconds. `cold-cold` shuts the Simulator down, clears benchmark-owned derived data, and boots it
again before every sample; `cold` stops the daemon and terminates the app. Cold-cold wall medians
fall by 57–68% and daemon medians by 62–72% against the baseline, measured while this host carried
substantially more load than the baseline's. Cold (booted Simulator, cold runner) improves by 9–26%.

## Result — warm, relaunch, and first interaction

Warm and relaunch carry 20 samples per cell; first interaction carries 10 and has no baseline-corpus
counterpart, so it is reported on its own.

| Screen | Warm wall | Warm wall (base) | Warm daemon | Warm daemon (base) | Relaunch wall | Relaunch wall (base) | First interaction wall |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| quiet | 169 | 154 | 89 | 50 | 3,876 | 3,645 | 928 |
| list | 291 | 312 | 202 | 209 | 3,888 | 4,378 | 1,436 |
| nested-scroll | 250 | 187 | 167 | 83 | 3,872 | 4,313 | 741 |
| alert | 224 | 207 | 139 | 104 | 3,896 | 4,370 | 1,005 |
| system-surface | 208 | 210 | 130 | 105 | 3,576 | 4,917 | 1,119 |
| xctest-stress | 213 | 208 | 128 | 105 | 3,868 | 4,260 | 1,302 |

Milliseconds. Relaunch is at or better than the baseline on five of six screens. Warm wall is within
±10% of the baseline on five of six screens; warm daemon duration is uniformly higher, which is the
finding below.

## Result — proxy transport (20 samples per screen at each added RTT)

The headline of the convergence work: a warm snapshot crossed the tunnel with far fewer round trips
than at the baseline, so added latency costs far less.

| Screen | Transport | 0 ms | 20 ms | 80 ms | 0 ms (base) | 20 ms (base) | 80 ms (base) |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| quiet | fresh CLI | 184 | 293 | 556 | 233 | 1,057 | 1,801 |
| quiet | persistent client | 103 | 158 | 282 | 273 | 562 | 806 |
| list | fresh CLI | 304 | 415 | 691 | 431 | 1,221 | 1,328 |
| list | persistent client | 214 | 280 | 408 | 254 | 719 | 729 |
| nested-scroll | fresh CLI | 260 | 377 | 643 | 188 | 1,116 | 1,108 |
| nested-scroll | persistent client | 179 | 240 | 381 | 138 | 590 | 616 |
| alert | fresh CLI | 241 | 343 | 615 | 210 | 1,113 | 1,362 |
| alert | persistent client | 148 | 203 | 351 | 108 | 622 | 637 |
| system-surface | fresh CLI | 217 | 319 | 595 | 209 | 1,119 | 1,145 |
| system-surface | persistent client | 128 | 183 | 330 | 105 | 537 | 638 |
| xctest-stress | fresh CLI | 229 | 340 | 562 | 225 | 1,136 | 1,395 |
| xctest-stress | persistent client | 136 | 197 | 314 | 127 | 612 | 619 |

Milliseconds, wall-clock medians. Going from 0 to 80 ms of added RTT costs 178–387 ms per snapshot
here, against 475–1,568 ms at the baseline. On the quiet fixture over the fresh CLI transport that
difference is about twenty RTT-bound exchanges per snapshot at the baseline against about five here;
over the persistent client it is about seven against about two. Every cell completed with zero failed
samples at every RTT, so the retry/timeout path is not what improved.

## Result — package size against #2189

| Measurement | `7c434b5758` | `71fb2483f3` | Delta |
| --- | ---: | ---: | ---: |
| Packed tarball | 1,409,306 B | 982,960 B | +43.4% |
| Clean-installed package | 4,723,895 B / 543 files | 3,347,347 B / 436 files | +41.1% / +107 |
| Bundled JavaScript | 3,775,024 B raw, 1,258,950 B gzip, 410 files | 2,480,947 B raw, 835,279 B gzip, 330 files | +52.2% raw, +50.7% gzip |

The span covers 196 commits of unrelated product work, so this delta cannot be attributed to the
snapshot convergence alone; it is recorded as the size at the measured head, and the leg reproduces
to the byte across independent runs (the same `1,409,306` tarball twice).

## Result — deterministic corpus and no-regrowth enforcement

| Gate | Command | Result |
| --- | --- | --- |
| Swift/TypeScript presentation differential | `pnpm test:ios-snapshot-differential` | pass (`swift test --package-path apple/snapshot-presentation`, plus 3 differential tests) |
| Engine conformance, properties, transitions, tree | `vitest run packages/capture-kit/src/ios-snapshot-engine` | pass (10 files, 67 tests) |
| Fuzz corpus replay | `vitest run scripts/fuzz/corpus-replay.test.ts` | pass (11 cases) |
| Fuzz worker lane | `pnpm test:fuzz-worker` | pass (11 cases) |
| Provider contracts | `pnpm test:integration:provider` | pass (66 files, 212 tests) |
| No-regrowth rules R72/R73/R74 | `pnpm check:layering` | pass (`ios-snapshot-engine-ownership`, `provider-snapshot-presentation-ownership`, `snapshot-assembly-presentation-neutrality`, wired in `scripts/layering/check.ts`) |
| Benchmark harness unit suite | `vitest run scripts/ios-snapshot-benchmark` | pass (17 files, 50 tests) |
| Deep-button controls | inside every corpus (`deepButtonEvidence`) | the shallow-rule control exits 1 with "changed descendant was omitted by shallow observation"; the safe control exits 0 |
| Affected gate | `pnpm check:affected --run` | see the PR; GitHub stays authoritative for provider integration, coverage, native builds, and device lanes |

## Finding — warm snapshot daemon cost is about double the baseline

Recorded here rather than hidden, and not explained by target, runtime, app, or load.

An off-corpus controlled diagnostic: same Simulator, same installed app, same ambient load
(1-minute average ~21), back-to-back runs of ten warm `interactiveOnly` snapshots of the smallest
fixture (4 nodes, ~3.4 KB), reading the daemon's own per-step duration.

| CLI under test | Durations (ms) | Median |
| --- | --- | ---: |
| `71fb2483f3` (baseline corpus head) | 68, 47, 46, 44, 43, 43, 43, 45, 47, 46 | 45.5 |
| `7c434b5758` (this head), round 1 | 97, 86, 84, 90, 84, 86, 86, 92, 83, 82 | 86 |
| `7c434b5758` (this head), round 2 | 98, 133, 96, 96, 88, 90, 87, 94, 107, 103 | 96 |

The published warm cells agree with the diagnostic (89–202 ms against the baseline's 50–209 ms), and
a repeat at a 1-minute load average of 3.8 still measured 86 ms, so contention is not the cause. The
shape is a roughly fixed ~40 ms per snapshot rather than work proportional to tree size. Candidates
in `71fb2483f3..7c434b5758` that add work to every capture: #2644 (reading the `NotEnabled` trait per
node), #2670 (publishing the captured keyboard band as a fact), #2693 (disclosing target
re-activation on every capture-consuming command), and #2661 (the single geometry-normalization
pass). This does not weaken the claims the corpora were measured for — one converged snapshot path,
no presentation branching in the assembly, the RTT and cold-cold improvements above — but it is a
real cost this head carries and it needs its own follow-up.

## Correction — the #2198 slice corpora are not parity baselines

The slice corpora published under `2198-slice-a-7616ba222d/`,
`2198-slice-a-first-interaction-fixed-e729321dcc/`, and `2198-slice-b-rtt-318d510769/` were measured
on branch heads (`7616ba222d`, `9189275dcb`, `e729321dcc`) that are **not ancestors** of `main`, and
two of their first-interaction cells carry ten failed samples each (the ambiguous-anchor harness bug
those slices themselves fixed). They are cited here as branch-lineage observations only. The pinned
`71fb2483f3` corpus is the comparison this record rests on.

## Reproduction

```sh
# one dedicated simulator, app installed, nothing else running a device
pnpm bench:ios-snapshot -- --udid <UDID> --screen quiet,list,nested-scroll,alert,system-surface,xctest-stress \
  --mode local --state cold-cold,cold --samples 10 --skip-package-size --out .tmp/cold.json
pnpm bench:ios-snapshot -- --udid <UDID> --screen quiet,list,nested-scroll,alert,system-surface,xctest-stress \
  --mode local --state first-interaction --samples 10 --skip-package-size --out .tmp/first.json
pnpm bench:ios-snapshot -- --udid <UDID> --screen quiet,list,nested-scroll,alert,system-surface,xctest-stress \
  --mode local --state warm,relaunch --samples 20 --out .tmp/warm-relaunch.json
pnpm bench:ios-snapshot -- --udid <UDID> --screen quiet,list,nested-scroll,alert,system-surface,xctest-stress \
  --mode proxy --rtt 0,20,80 --samples 20 --bandwidth-kbps unlimited --packet-loss 0 --skip-package-size \
  --out .tmp/proxy.json
pnpm bench:ios-snapshot:evidence   # schema and hash check against PUBLISHED_CORPORA
```

Legs must not overlap: one subprocess-backed gate per host, otherwise the samples contend and the
cell admission stops the run rather than reporting mixed timings.
