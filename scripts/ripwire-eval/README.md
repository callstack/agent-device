# ripwire evaluation harness

Measures whether [ripwire](https://github.com/redhat-et/ripwire) — a compiled, offline
code-context tool that hands an agent a ranked call graph instead of a pile of files — makes
agents working on this repository more accurate, cheaper, or both.

Findings: [`docs/ripwire-context-tooling-evaluation.md`](../../docs/ripwire-context-tooling-evaluation.md).

## The benchmark

`tasks.json` replays six real merged `agent-device` commits. Each task carries the change's
intent in prose — the symptom and the fix, with no file names — and the commit's own file list as
ground truth. The agent works in a clone pinned at the commit's **parent**, so the answer is not
in the tree.

Ground truth excludes `CHANGELOG.md`, `website/` docs and generated ledgers/fixtures: those are
conventions, not localization.

## Setting up

```sh
# 1. Build ripwire (C++23, no runtime dependencies) somewhere OUTSIDE this repository.
git clone https://github.com/redhat-et/ripwire /tmp/ripwire
cmake -S /tmp/ripwire -B /tmp/ripwire/build -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build /tmp/ripwire/build          # the binary lands at /tmp/ripwire/build/ripwire

# 2. Cut one leak-free clone per task, pinned at its commit's parent. Run it from an
#    agent-device checkout — `origin` for the task clones is THIS repository.
scripts/ripwire-eval/setup-clones.sh /tmp/rw
```

`setup-clones.sh` shallow-fetches each parent SHA into its own repository and then *proves* the
fix commit is unreachable from it, failing rather than handing an agent the answer. A `git
worktree` would not do: it shares `.git` with the main checkout, so the commit under test would be
one `git log --all` away. The fetch names the full SHA because git refuses to fetch an abbreviated
one, which is why `tasks.json` carries full SHAs.

## Running

### The deterministic halves — reproducible run to run, no model in the loop

```sh
node scripts/ripwire-eval/retrieval-bench.mjs --ripwire=/tmp/ripwire/build/ripwire --worktrees=/tmp/rw
node scripts/ripwire-eval/affected-bench.mjs  --ripwire=/tmp/ripwire/build/ripwire --worktrees=/tmp/rw
```

`retrieval-bench` asks what a single ripwire call surfaces from the raw task text and what it
costs. Its recall is over the change's **existing** files only: a retrieval verb ranks what the
tree contains, so a file the commit created is not a hit it could have scored.

`affected-bench` feeds it the change's non-test sources and checks whether the change's own test
files come back. It scores **test files** (`*.test.ts`) only. Files that merely live in a test
location — `__tests__/test-utils/fake-adb.ts`, `__tests__/runtime-port-fixtures.ts`, a
provider-scenario world — are helpers: neither a source the change starts from nor a harness
`--affected` could name. They are listed per task under `helpers_not_scored` and counted in
neither column.

Both write their result JSON next to this README. Run `pnpm format` afterwards; the scripts emit
plain `JSON.stringify` output and oxfmt owns the checked-in shape.

### The agent A/B — an archived observation, not a scripted experiment

**Read the A/B numbers as a recorded result, not as something these commands will reproduce.**
The two arms were driven by subagents inside a Claude Code session, not by a runner in this
repository, so re-running them depends on an agent runtime this harness does not own and on a
model that is not pinned here. What *is* preserved is everything that made the comparison fair,
and it is enough to repeat the design or to audit the one that ran:

- `arms/baseline.md` and `arms/ripwire.md` — the two tooling paragraphs, verbatim. They are the
  **only** difference between the arms.
- `make-briefs.mjs` — renders the 12 briefs from those two files and `tasks.json`. It reproduces
  the briefs the recorded runs were given byte-for-byte:

  ```sh
  node scripts/ripwire-eval/make-briefs.mjs \
    --worktrees=/tmp/rw --out=/tmp/rw-briefs --ripwire=/tmp/ripwire/build/ripwire
  ```

- `runs/` — the 24 answers as returned, one file per (task, arm, replicate), each carrying the
  runtime's own `subagent_tokens`, `tool_uses` and `duration_ms` rather than a self-estimate.

To repeat it: generate the briefs, run each as one agent with the tools its arm names, save each
answer as `runs/<task>-<arm>-r<n>.json` in the shape those files already use, and score:

```sh
node scripts/ripwire-eval/score.mjs --runs=scripts/ripwire-eval/runs --worktrees=/tmp/rw
```

`--worktrees` is optional; with it, each run also reports the byte size of the files it opened,
measured from the pinned clone rather than taken from the agent's own account.

Execution configuration behind the recorded runs: 24 runs (6 tasks x 2 arms x 2 replicates), one
subagent per run with a fresh context, both arms on the same model, ripwire 0.5.0 built from
`ef6168b18` with its index already warm for each clone.

## What is checked in here

- `tasks.json` — the six tasks and their ground truth.
- `arms/` — the two tooling paragraphs that define the A/B; `make-briefs.mjs` renders the briefs.
- `bench-cli.mjs` — the flag reader, the tasks file and the one timed ripwire invocation.
- `runs/` — the 24 raw subagent answers, one file per (task, arm, replicate).
- `agent-results.json`, `retrieval-results.json`, `affected-results.json` — scored output of the
  three benches, regenerated by the commands above. Run `pnpm format` after regenerating; the
  scripts write plain `JSON.stringify` output and oxfmt owns the checked-in shape.
