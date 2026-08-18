# Oracle-negation spike: are our unit tests load-bearing?

**Question** (2026-08-07): with a large unit suite and a mock-free
provider-integration lane, which unit tests are decorative and safe to remove?
Coverage intersection cannot answer this — two tests on the same covered path
can check entirely different behaviour (the checked-coverage argument:
coverage says a line *ran*, not that any assertion *depended* on it). So this
spike measured oracle liveness directly.

## Method

Invert every assertion in every `*.test.ts` file and re-run the suite. A test
that **passes with all its assertions inverted** has no live oracle: its
assertions either never execute or cannot distinguish anything. A test that
fails is load-bearing on at least one executed assertion.

- `expect`: a proxy routes every terminal matcher through one extra `.not`.
  Chai's `.not` is a flag-*set*, not a toggle, so stacking `.not` on a
  user-negated chain is a no-op — the proxy instead tracks user `.not` as
  parity and inverts those chains by *removing* the negation (calling the raw
  matcher). `resolves`/`rejects` wrap recursively; statics pass through.
- `node:assert/strict`: a wrapper module inverts each method (holding throws,
  failing swallows; promise-returning methods invert asynchronously).
  `assert.fail` keeps its always-throw semantics — a reached
  `fail('unreachable')` is a live oracle.
- A codemod rewrites the two (uniform) import shapes in test files only;
  shared helpers/worlds keep natural assertions. Setup files are excluded.
- Self-check per the vacuity doctrine in `testing.md`: seven planted tests
  (dead-branch expect/assert, never-invoked callback, plain matcher, user
  `.not`, async `rejects`, executed assert) all produced the expected verdict
  before the sweep ran.

Harness lives in session scratch (`.tmp/negation/`): `neg.ts` (proxy),
`negated-assert.ts` (wrapper), `codemod.mjs` (import rewriter). Re-creating it
from this description is ~150 lines.

## Result: zero vacuous tests

Sweep across all five Vitest projects, 677 files codemodded, 5,687
verdict-bearing tests: **5,537 failed under negation (live), 150 passed** —
and every survivor decomposed into a harness artifact or a real-but-indirect
oracle, verified by reading each cluster:

| Survivors | Class | Verdict |
| --- | --- | --- |
| 112 | `assert.rejects`/`assert.throws` with a validator callback: the negated validator throws *inside* the un-negated outer wrapper, which reports "rejected as required" either way | Live — the pattern itself proves an executed error-path oracle |
| 31 | Oracle lives in a shared un-negated helper (`assertRpcError`, `assertInvalidArgsMessage`, `gesture-plan-test-utils.ts`, interaction-contract helpers) | Live — sampled four distinct clusters and confirmed each |
| 6 | A guard assertion *inside an in-file fake* (e.g. `readSessionPort`'s `assert.notEqual(index, -1)` in `snapshot-helper-session.test.ts`) inverted and broke the fake, flipping the production path so the real assertions went false-and-swallowed | Live — artifact of negating the whole file |
| 1 | `watchos-sentinel.test.ts`: the only assertion sat in a `catch` that never fires (tvOS interactor creation succeeds) | Conditionally live; strengthened to an unconditional success pin in this spike — the strengthened oracle flips from survivor to failure under negation |

So the suite's oracles are in excellent shape, and **no deletions are
justified by vacuity evidence**. This matches the assertion-density audit run
alongside: 3.4 assertions/test overall, only ~2.4% of assertions are pure
mock-introspection (`toHaveBeenCalledWith`-style with no behavioural check).

## Companion measurement: coverage uniqueness of mock-coupled tests

150 test files mock first-party modules (306 of 316 `vi.mock` calls target our
own code). Excluding them from a full coverage run:

| Run | Lines | Branches |
| --- | --- | --- |
| Full suite | 89.73% | 78.94% |
| Minus the 150 mock-coupled files | 77.85% | 67.25% |
| Mock-free integration lanes only | 48.41% | 37.86% |

The mock-coupled files uniquely hold 4,847 lines across 283 production files —
but only **47 files drop below 20% coverage** without them. Those 47 are not a
test-discipline problem; they map onto production modules that bypass the
provider seams (`src/platforms/android/devices.ts` calls `runCmd('adb', …)`
around `AndroidAdbProvider`; `runner-session.ts` calls `runCmdBackground('xcodebuild', …)`
because `AppleToolProvider` has no background member; `agent-browser-provider.ts`,
`daemon-client-lifecycle.ts`, `perf-xctrace.ts` likewise). Close a seam and its
mock-only tests become provider-scenario-reachable — and the module becomes
eligible for the mutation registry, whose membership rule excludes
subprocess-spawning code by construction.

## What would license pruning (and what to do instead)

Neither coverage overlap (unpredictable fault-detection loss in the suite-
minimization literature) nor oracle liveness (this spike: everything is live)
identifies removable tests here. The remaining mechanical instrument is
**mutation score deltas**: a test whose removal does not lower its module's
mutation score is redundant *with evidence*. That is `pnpm mutation:affected`
scope-widened, and it becomes affordable per-PR by mutating only changed lines.

Follow-ups this spike motivates, in value order:

1. **Diff-scoped mutation gate** — mechanize the `testing.md` red-run rule:
   mutate the lines a PR changes; require the PR's tests to kill them.
2. **Seam closures** for the 47 sole-owner modules above; each closure moves
   files out of the serialized `subprocess-stub` project (#1823).
3. **Transcript provenance** — provider-scenario worlds are hand-authored
   beliefs about `simctl`/`adb` output. Add a capture mode on the live-device
   lanes and a nightly drift diff, the same shape as the replay-compat corpus
   and its provenance check.
4. **Wiring-assertion strengthening** — the files where mock-introspection
   assertions concentrate (`snapshot-handler.test.ts`, `interaction.test.ts`,
   `session-open-url-prewarm.test.ts`, `react-native.test.ts`) are candidates
   for asserting response payloads instead of dispatch call shapes.

## Re-run checklist

1. Rebuild the three harness files (see Method) under `.tmp/negation/`.
2. Codemod, then `pnpm exec vitest run --reporter=json --outputFile=…`.
3. Classify survivors *before* believing them: peel `assert.rejects`
   validators, in-file-fake breakage, and helper-oracle files first — in this
   run, 149 of 150 survivors were exactly those three classes.
4. `git restore src packages test scripts` — the codemod globs stop at src/packages/test today, but restore wider than you codemodded; the negated imports must never reach a commit.
