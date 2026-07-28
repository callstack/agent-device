# Repo-health snapshot

```sh
pnpm repo-health            # human-readable summary
pnpm repo-health --json     # the raw JSON snapshot on stdout
pnpm repo-health --out p    # also write the JSON snapshot to a file
```

One JSON snapshot aggregating the signals this repo already computes across 24+ CI checks, so an
agent can query the repo's state in one read instead of scraping job logs. It is **data, not a
dashboard** (#1409's lesson): there is no rendering, and it draws no conclusions for you.

It reuses each analyzer rather than reimplementing any metric, runs from a clean checkout in well
under two minutes, and needs no network — everything comes from the working tree, `git`, and the
artifacts other gates already write.

## What it does NOT do

- **No history / trends / PR comments.** That is the follow-up quality-delta issue (#1424); this
  snapshot is the input it persists.
- **No gating on component metrics.** Instability / abstractness / main-sequence distance are
  observatory data to locate concrete high-fan-in modules worth pinning harder (CONTEXT.md
  "Principles and their gates"). They must **never** become CI thresholds.
- **The one thing that can fail the command** is the depgraph-vs-layering R6 consistency
  assertion — see below.

## The R6 consistency assertion (the only wired-into-CI part)

The dependency graph the snapshot builds must reproduce the layering gate's
`TYPE_INVERSION_BASELINE` (`scripts/layering/check.ts`), pair for pair (#1410). `pnpm repo-health`
exits non-zero and prints the difference when they diverge. The **identical** assertion is already
wired into CI by the **Layering Guard** job, which runs `scripts/depgraph/model.test.ts` — so no
new CI job or cost is added here. The gate stays the authority: a mismatch means the tree or the
baseline changed, never the snapshot.

## Schema (`schemaVersion: 1`)

Field names are the stable **trend/delta contract** consumed by #1424. Any change bumps
`schemaVersion`; #1424 refuses to diff across schema versions without a migration note.

```jsonc
{
  "schemaVersion": 1,
  "provenance": {
    "schemaVersion": 1,
    "commit": "<full HEAD sha>",
    "ref": "<branch or GITHUB_REF_NAME>",
    "node": "v22.x",
    "generatedAt": "<ISO 8601>",
    // Content hash per analyzer/config, standing in for a version: a source change is a version bump.
    "tool": { "depgraph": "…", "layering": "…", "fallow": "…", "coverage": "…", "size": "…",
              "slowTest": "…", "bench": "…", "skillgym": "…" },
    "inputs": {
      "sourceFiles": 932,                              // production files fed to the graph build
      "lockfile": { "path": "pnpm-lock.yaml", "sha256": "…" },
      // coverage and size are read artifacts this command does NOT produce. Their freshness relative
      // to `commit` is proven ONLY from a producing commit the artifact stamps in its own bytes —
      // never mtime (a copy/restore/CI-cache download resets it) nor an enumerated input list (never
      // provably complete). status: "fresh" = stamped commit == HEAD; "stale" = stamped commit !=
      // HEAD; "unknown" = no stamp. Today neither producer stamps a commit, so both report "unknown"
      // (honest — cannot be proven current); if one starts emitting `commit`, it is verified. The
      // bytes are still hashed so #1424 keys history on the exact metrics. A consumer must treat
      // "unknown"/"stale" alike as not-current, never as `commit`.
      "coverageSummary": { "path": "coverage/coverage-summary.json", "sha256": "…",
                           "producerCommit": null, "status": "unknown" } | null,
      "sizeReport": { "path": ".tmp/size-report.json", "sha256": "…",
                      "producerCommit": null, "status": "unknown" } | null
    }
  },
  "metrics": {
    "depgraph": {                    // from scripts/depgraph (reuses the layering edge model)
      "files": 932, "edges": 4791,
      "valueCycles": 0, "typeCycles": 7, "dynamicCycles": 1,
      "redundantEdges": 1366,        // value edges also reachable at distance >= 2 (NOT removable)
      "backEdges": 0,                // R5 ranked-spine value back-edges (gate keeps this at 0)
      "typeInversionEdges": 7        // R6 type-only spine inversions, summed
    },
    "layering": {                    // ratchet values from scripts/layering/check.ts
      "typeInversionBaseline": { "commands -> client": 3, "…": 0 },
      "typeInversionTotal": 7,       // R6 ratchet (may only shrink)
      "typeCycleBaseline": 102       // R9 largest-type-cycle ceiling (growth-only)
    },
    "coverage": {                    // from coverage/coverage-summary.json (json-summary reporter)
      "available": true,
      "lines": { "total": …, "covered": …, "pct": … },
      "statements": …, "functions": …, "branches": …
    },                               // { "available": false } when the artifact is absent
    "size": {                        // from .tmp/size-report.json (scripts/size-report.mjs)
      "available": true,
      "jsRawBytes": …, "jsGzipBytes": …, "npmTarballBytes": …, "npmUnpackedBytes": …
    },                               // { "available": false } when the artifact is absent
    "fallow": {                      // from fallow-baselines/*.json + .fallowrc.json
      "deadCodeFindings": 0, "healthFindings": 161,
      "suppressions": { "ignoredExports": …, "ignoredDependencies": …, "total": 19 }
    },
    "slowTest": {                    // ratchet state from scripts/vitest-slow-test-reporter.ts
      "unitBudgetMs": 2500, "integrationBudgetMs": 15000, "enforceFactor": 2
    },
    "bench": { "cases": 19, "topics": 10 },   // scripts/help-conformance-cases.mjs registry
    "skillgym": { "cases": 5 },               // test/skillgym/suites/agent-device-smoke-suite.ts
    "components": {                  // OBSERVATORY ONLY — never a CI threshold
      "byZone": [
        { "zone": "kernel", "rank": 0, "classification": "ranked",
          "files": …, "loc": …,
          "afferent": 764, "efferent": 0,   // cross-zone couplings (Ca / Ce)
          "instability": 0.0,               // I = Ce / (Ca + Ce)
          "abstractness": 0.36,             // A ≈ type-only share of afferent edges (approx.)
          "distance": 0.64 }                // |A + I - 1|
      ]
    },
    "mainSequence": {                // OBSERVATORY ONLY
      "concreteHighFanIn": [         // concrete (A < 0.5), fan-in >= 10, most-depended-on first
        { "file": "utils/exec.ts", "zone": "utils", "fanIn": 81, "fanOut": 3,
          "instability": 0.04, "abstractness": 0.17, "distance": 0.79, "concrete": true }
      ]
    }
  },
  "consistency": { "r6": { "ok": true, "expected": { … }, "actual": { … } } }
}
```

### Coverage and size availability

`coverage` and `size` are read from the artifacts the coverage and size gates already produce
(`coverage/coverage-summary.json` via the vitest `json-summary` reporter; `.tmp/size-report.json`
via `pnpm size:markdown`). Recomputing either would blow the two-minute / no-network budget, so a
clean checkout that has run neither gets `{ "available": false }` with the producing command
named in the summary. Run `pnpm test:coverage` and/or `pnpm size:markdown` first (or point #1424's
history job at a run that already did) to populate them.

### Abstractness is a first approximation

Per the issue, `abstractness` approximates a component's type-only export share by the share of
its **incoming edges that are type-only**. A module most of whose dependents import it for values
(e.g. `src/utils/exec.ts`, `src/daemon/ref-frame.ts`) reads as concrete; when its fan-in is also
high, it is a foundation worth pinning harder. This is a locator, not a verdict.
