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
# 1. Build ripwire (C++23, no runtime dependencies)
git clone https://github.com/redhat-et/ripwire && cd ripwire
cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release && cmake --build build

# 2. Cut one leak-free clone per task, pinned at the parent commit.
#    A shallow fetch of the parent SHA is what keeps the fix commit unreachable — a plain
#    worktree shares .git with the main checkout and would hand the agent the answer.
for pair in T1:1f9d940 T2:e0f8c55 T3:7bcbf13 T4:a9283fa T5:ff59309 T6:6768a04; do
  id=${pair%%:*}; sha=${pair##*:}
  mkdir -p /tmp/rw/$id && git -C /tmp/rw/$id init -q
  git -C /tmp/rw/$id remote add origin "$PWD"
  git -C /tmp/rw/$id fetch -q --no-tags --depth=20 origin "$sha"
  git -C /tmp/rw/$id checkout -q --detach "$sha"
done
```

## Running

Deterministic halves — no model in the loop, so they are reproducible run to run:

```sh
node scripts/ripwire-eval/retrieval-bench.mjs --ripwire=<bin> --worktrees=/tmp/rw
node scripts/ripwire-eval/affected-bench.mjs  --ripwire=<bin> --worktrees=/tmp/rw
```

`retrieval-bench` asks what a single ripwire call surfaces from the raw task text and what it
costs. `affected-bench` feeds it the change's non-test files and checks whether the change's own
test files come back.

Agent half — two arms over the same six tasks, identical prompts except the tooling paragraph:

1. Generate a brief per (task, arm) from `tasks.json` — the task prose, the pinned clone path,
   the rules, and the JSON deliverable contract.
2. Run each brief as a subagent. The **baseline** arm gets Read/Grep/Glob/Bash; the **ripwire**
   arm gets the same plus the ripwire binary and its verb table.
3. Save each answer as one JSON file per run: `{task, arm, rep, files, new_files, files_opened,
   subagent_tokens, tool_uses, duration_ms, notes}`.
4. Score them:

```sh
node scripts/ripwire-eval/score.mjs --runs=<dir-of-run-json>
```

`score.mjs` reports per-run and per-arm file-level recall, precision and F1 against ground truth,
alongside the token, tool-call and wall-clock cost of producing the answer.

## Caveats that travel with these numbers

- Six tasks, two replicates. Enough to size an effect, not to make a small one significant.
- Both arms run the same model. The result is about tooling, not about model choice.
- The clones are shallow (20 commits), so ripwire's churn and co-change lenses see a truncated
  history. That handicaps ripwire relative to a full checkout.
- ripwire indexes were warm when the agents ran. Cold-index cost is measured and reported
  separately rather than folded into per-run wall clock.
