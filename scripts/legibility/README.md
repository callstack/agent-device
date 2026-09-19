# Placement-legibility report

```sh
pnpm legibility                                 # seeded 300-file sample -> .tmp/legibility/report.json
pnpm legibility --all --out .tmp/legibility/report.json
pnpm legibility --all --ablation                # plus the name-withheld pass (a second full pass)
pnpm legibility --with-test-dir --raw-subject   # also print the two leak references
pnpm legibility:test                            # offline, no key
```

Can an outside reader file a module into its owning family from its imports, its test, and the
subject of the commit that placed it? The report asks the `typesafe-ai/jev` evaluation model one
choice question per file through AI Gateway and scores it against where the file actually landed,
next to three baselines. Needs `AI_GATEWAY_API_KEY` for the report, never for its tests, and
`ai >= 7.0.106` — the first release exporting `experimental_evaluate`; 7.0.68 does not.
Report-only: nothing here gates.

## What it answers

Per file, in this order, the evidence is: value-import targets resolved to repository paths
(the file's own path is never shown), external specifiers verbatim, the mirrored test's
basename, and the placement commit's subject with the `type(scope):` prefix and `(#NNNN)`
stripped. Two conditions differ in what they do to those paths:

- **reader** (scored) — paths appear as they are on disk, which is what anyone opening the tree
  sees. The subject is still redacted, because it narrates a change rather than a layout.
- **name-withheld** (`--ablation`) — every family id in the answer space is replaced by `«x»` in
  the paths too, matched as a word sequence so `hostKit`, `host/kit`, and `Host Kit` go with
  `host-kit`.

The scored number is the reader condition. The withheld pass is an **ablation**, reported as the
gap to the reader number: that gap is what the names themselves carry. It is not a score, and the
baselines below are not comparable to it — they read the physical layout, so they are comparable
to the reader number only.

Two rates are printed. Under the withheld condition the scrubber's own misses are a defect and the
run refuses to send anything above 1%. Under the reader condition the same audit is the **name
echo**: the share of files whose evidence already names their own family, which is a property of
the tree being legible and is reported, not capped.

Three baselines are computed on the same files and printed next to the model:

- **majority** — the largest family for everything;
- **neighbour-vote** — the family holding a strict majority of the file's import targets,
  abstaining (scored wrong) otherwise;
- **k-NN** — a similarity-weighted vote over the 5 nearest files by Jaccard over import-path
  sets, self excluded, falling back to majority for files without imports.

The baselines see the physical layout of every other file, as the reader condition does. A model
number under the reader condition that does not beat k-NN means the model is no better than a
similarity vote over the same visible layout.

## What the numbers do not mean

**This is not a removability or correctness claim, and a low family score is not a defect
report.** The measure is whether a family's name and its files' surface carry the placement
question; it says nothing about whether the code is right, whether the family should exist, or
whether any file should move. In particular:

- `contracts` scores ~1%. A vocabulary family's imports point outward at everything, so its
  legible surface is its entry names and its importers, which neither condition shows. Do
  not read it as misplacement; fixing the measure for rank-1 families needs in-edges as
  evidence (a follow-up that must keep these conditions reproducible for comparison).
- `daemon-server` is the one family whose source folder (`src/daemon/`) differs from its id.
  The folder name is not scrubbed even under the ablation — it is not an answer option and the
  folder name **is** the name under test — so its ablation score is legibility of that folder
  name, not of the id.
- `platform-runtime` is a one-file family whose name the model finds attractive: on the full
  tree it absorbs 209 wrong predictions, mostly `(root)` (52), `contracts` (49), `daemon-server`
  (29), and `platform-apple` (20) files whose import paths say "runtime". That is a fact about the
  answer space, and the family itself is `n = 1` so it never enters a headline.
- A family row with fewer than 3 sampled files is shown with `*` and is never averaged into a
  headline; the best/worst spread only considers families with at least 20 samples.
- The two flags `--with-test-dir` and `--raw-subject` relax one rule each on top of the reader
  line — the mirror test's directory, and the raw commit subject. They are printed as **leak
  references**, upper bounds with the answer leaked back in, never as the score.
- `--ablation` costs a second full pass, so it is opt-in. Its gap is a statement about names, not
  a difficulty score: a tree with a high echo rate is easy to read and hard to ablate.
- Unanswered files (a batch that fails whole-call validation is halved and retried; a single
  file that still fails is recorded with a typed reason) are reported, never dropped, and never
  counted as correct.

## Reference values (2026-09-19, commit a556e114cd, full tree, 1,726 files, 39 families)

| condition | accuracy |
| --- | --- |
| majority | 18.1% |
| neighbour-vote | 30.1% |
| k-NN (k = 5) | 43.6% |
| model, **reader** (the score) | **52.3%** |
| model, name-withheld ablation | 38.1% (−14.2 vs reader) |

Name echo 702/1,726 (40.67%); scrubber defect with names withheld 0/1,726. 60 scored requests of
40 questions, 8 splits, 0 unanswered; 2,682,688 input and 2,354,385 output tokens across all four
passes ($0.1127 at $0.042/M input). Leak references: 67.0% (`--with-test-dir`), 64.0%
(`--raw-subject`). Best → worst with `n >= 20`: `managed-allocation` 100, `selectors` 96.8,
`host-kit` 88.6, `provider-webdriver` 83.3, `platform-android` 81.3, `platform-apple` 76.0,
`commands` 74.2, `provider-limrun` 65.5, `command-registry` 61.5, `maestro` 54.3, `capture-kit`
53.1, `daemon-server` 49.0, `platform-harmonyos` 38.1, `cli` 19.0, `kernel` 18.2, `contracts`
14.2, `(root)` 2.6. Seeded 300-file sample (seed 2677): reader 55.4%, ablation 40.2%, references
69.3% and 64.3%, echo 42.67%.

The −14.2 ablation gap is the whole point of running both: names carry 14 points of placement
judgement on top of what the layout's neighbourhood already gives k-NN. The issue that commissioned
this report (#2677) first recorded 49.7% from a prototype that showed real paths, then 37.5% from
this rebuild, which had scrubbed them — a condition mismatch, not a model shift. Reader 52.3% and
ablation 38.1% now sit on the two sides of that pair, and the baselines are only ever compared to
the reader number.

## What is authoritative

`scripts/layering/` is, for the file set and family partition (`listSourceFiles`,
`targetDagZone`), and for import edges (`resolveImportEdges`, `parseImports`). Tests are
enumerated by the same tracked-file scan. First-touch subjects and rename status come from
`scripts/repo-history/`; per-family `Q_f` and out/in flow come from `scripts/coupling/` over
that same history. Nothing here re-derives zones, file sets, or edges.

The evaluation call sits behind one seam (`jev-client.ts`); `batches.ts`, `score.ts`, and
`run.ts` are tested with a fake that returns canned answers, including a tie-failing response
that proves the split-and-retry path.

## What the JSON carries

- `generated` — commit, date, counts, condition, and the sampled ids (same seed ⇒ same set).
- `leak` — files audited, the leaking ids, the rate, and the limit, measured with names withheld.
- `nameEcho` — the same audit over the reader line: files whose evidence already names their own
  family. Reported, never capped.
- `requests` / `usage` — calls, splits, cap, tokens, and cost. Cost counts every pass made.
- `baselines` — majority, neighbour-vote, k-NN, and the model, over the same answered files.
- `headline` — the numbers above plus the `n >= 20` spread.
- `perFamily[]` — `family, files, n, answered, accuracy, knn, delta, medianConfidence,
  modularity, outInFlow, smallSample`. `medianConfidence` is the provider's separate
  confidence statistic, not the selected option's probability.
- `divergences[]` — `id, family, predicted, p, viaRename, subject` where the model and k-NN
  independently agree on another family.
- `unanswered[]` — `id` and a typed reason (`call-failed` or `request-cap`).
- `ablation` — the name-withheld accuracy, its answered count, requests, and `delta` against the
  reader number; `null` when `--ablation` was not passed.
- `leakReferences[]` — the labelled upper-bound conditions, when requested.
- `files[]` — per file: prediction, `p`, top-3 distribution, confidence, baselines.
