# ripwire evaluation: does a code-context tool help agents work on this repository?

Measured 2026-09-08 against [ripwire](https://github.com/redhat-et/ripwire) v0.5.0, built from
source at `ef6168b18` (GCC 13.3.0, Release+LTO) on a 4-core Linux container. Harness, task
definitions and raw results: [`scripts/ripwire-eval/`](../scripts/ripwire-eval/).

ripwire is a single compiled binary that parses a repository into a ranked call graph and answers
questions about it from the shell — no API key, no embeddings, no index server. The question this
document answers is narrower than "is it good": **does handing it to an agent change what that
agent produces on this repository, and at what cost?**

## What was measured

Three things, two of them with no model in the loop.

1. **Retrieval** — what one ripwire call surfaces from a task description, and what it costs.
2. **Test selection** — given a change's source files, does it name the change's test files.
3. **Agent A/B** — paired subagents localizing six real merged commits, one arm with ripwire and
   one without, scored against the commits themselves.

The benchmark replays six merged `agent-device` PRs. Each task states the change's intent in prose
with no file names; the agent works in a clone pinned at the commit's **parent**, cut with a
shallow fetch so the fix commit is unreachable rather than merely off-limits. Ground truth is the
commit's own file list, minus `CHANGELOG.md`, `website/` docs and generated ledgers.

| Task | Replays | Area | Ground-truth files |
| --- | --- | --- | --- |
| T1 | #2366 standalone Maestro `clearState` | `packages/maestro` + daemon adapter + conformance corpus | 16 |
| T2 | #2290 editable-field metadata in digest snapshots | `platform-android` + `kernel` + daemon views + Java helper | 7 |
| T3 | #2356 orientation waits for the display to rotate | `platform-android` + provider scenarios | 5 |
| T4 | #2382 plain-session client reads its own failure record | daemon HTTP server + tenant scope | 7 |
| T5 | #2344 per-poll timeline in wait timeouts | `src/commands/interaction/runtime` | 4 |
| T6 | #2331 detached single-flight Simulator target discovery | `platform-apple` | 3 |

## Fit with this repository

ripwire ingests the tree in **4.9 s cold / 0.74 s warm**, ~196 MB peak RSS, 18 MB of cache on
disk. It reports **4,037 files, 33,002 symbols, 30,651 edges**. TypeScript, Swift, Java and Python
are parsed; the gaps here are 52 `.ad` replay-compat scripts (this project's own DSL — fixture
data, no call graph to lose) and 8 Kotlin files (the Maestro conformance JVM harness). Nothing
load-bearing is dark.

For scale: `ripwire .` costs **22.6 KB** (~5.6K tokens) against 33 KB for `README.md` +
`AGENTS.md` + `CONTEXT.md` and 63 KB with `docs/agents/` added. `--recall="<question>"` answers
from the doc corpus in **15.4 KB** where this repo carries **799 KB across 68 markdown files** —
a 52× reduction on "what do we already know about X".

## 1. Retrieval from raw task text (deterministic)

One call per task, fed the task description verbatim, scored on how many ground-truth files it
names. `for-idents` is the same `--for` verb fed only the identifiers the task text itself puts in
backticks — a mechanical distillation, included to separate ranking quality from phrasing.

| Verb | Mean recall | Mean bytes | Mean ms |
| --- | --- | --- | --- |
| `--for="<task>"` | 0.29 | 10.2 KB | 1042 |
| `--pack-task="<task>"` | 0.31 | 11.8 KB | 969 |
| `--pack-task` `--token-budget=4000` | 0.29 | 8.6 KB | 957 |
| `--for="<backticked identifiers>"` | 0.33 | 10.5 KB | 987 |

Per task, best verb: T1 0.31, T2 0.43, T3 0.20, T4 0.71, T5 0.75, T6 0.33.

**Read this as a floor, not a verdict.** One shot from a raw symptom paragraph is not how an agent
uses the tool, and the spread is instructive: where the task's vocabulary matches the code's
(T4 tenant scope, T5 wait polling) a single call lands 71–75% of the change set inside ~10 KB.
Where the task is described in symptoms whose words appear nowhere in the code (T6: "loaded host",
"pays it again"), the same call returns nothing useful — and the mechanically distilled
identifier query recovers it (0.00 → 0.33). `--for` is BM25 over subtokens and bodies; a long
prose paragraph dilutes the terms that carry the signal. **Short, identifier-shaped queries
beat pasting the ticket.**

The first ground-truth file appears at rank 1 in 4 of 6 tasks and rank ≤ 8 in all but T6's default
route, so when it finds anything it ranks it near the top.

## 2. Test selection (deterministic)

This repository's rule is that tests mirror source one-to-one, which makes "I changed these
sources, which tests do I run" a question with a checkable answer. Each task's non-test
ground-truth files were fed to `--affected`; the score is whether the commit's own test files came
back. Files the commit *created* are excluded — a selector cannot name a file that does not exist.

| Task | Expected tests found | Tests selected | Bytes |
| --- | --- | --- | --- |
| T1 | 2 / 5 | 65 | 9.0 KB |
| T2 | 1 / 1 | 185 | 19.6 KB |
| T3 | 1 / 2 | 7 | 2.8 KB |
| T4 | 2 / 2 | 25 | 4.5 KB |
| T5 | 2 / 2 | 18 | 3.7 KB |
| T6 | 1 / 2 | 2 | 2.1 KB |
| **Total** | **9 / 14 (64%)** | | |

Two of the five misses are not test files at all — `fake-adb.ts` and `runtime-port-fixtures.ts`
are test *utilities*, which `--affected` reports as reached symbols rather than as `<test>` rows.
The T6 miss is real: `snapshot-route.test.ts` covers the direct caller of the changed module and
should have been a short hop.

Selection breadth is the sharper problem. T2 named **185** test files for a 5-file change: the
seeds reach into `packages/kernel`, whose symbols are called from everywhere, and the walk has no
notion of "this hub is not evidence". At that width the answer costs more to read than it saves.
`--affected` is useful here at 2–25 selected files and not useful at 185.

This does not overlap `pnpm check:affected`, which selects CI *lanes* from a diff. `--affected`
selects test *files* from source files. They answer different questions.

## 3. Agent A/B: does an agent localize better with it?

Two arms over the same six tasks, two replicates each. Identical briefs — the same prose, the same
pinned clone, the same rules, the same JSON deliverable — differing in exactly one paragraph:

- **baseline**: Read, Grep, Glob, Bash. No code-intelligence tool on the machine.
- **ripwire**: the same tools, plus the binary and its verb table, told to reach for it first.

Both arms ran the same model. Each agent returned the change set it predicted; the harness scored
it against the commit. Cost is the subagent's own token spend, tool-call count and wall clock, as
reported by the runtime rather than self-estimated.

## 4. The one question this repo has already answered in prose

`docs/agents/cli-flags.md` names, by hand, the declaration sites a new CLI flag must be threaded
through. That makes it the cleanest possible head-to-head between a call graph and a maintained
routing doc. Asked the same question, one ripwire call names:

| Declaration site (from `docs/agents/cli-flags.md`) | `--for="<task in prose>"` | `--for="<the type and helper names>"` |
| --- | --- | --- |
| `packages/contracts/src/cli-flags.ts` | — | yes |
| `src/commands/cli-grammar/*` | yes | yes |
| `src/commands/command-projection.ts` | — | — |
| `src/cli-schema/command-overrides.ts` | — | — |
| `src/cli-schema/cli-config.ts` | — | yes |

`--pack-task --partition=3`, the verb aimed at fanning work out to parallel agents, produces three
slices with `overlap_max=0.000` in 1.3 s and 25 KB total — a clean split, naming 44 files, 2 of
these 5 sites among them.

**A ranked call graph does not recover a convention.** These sites are related by a rule the team
wrote down, not by call edges: `PROJECT_CONFIG_FLAG_KEYS` is a positive allowlist, and
`SCHEMA_ONLY_CLI_COMMAND_SCHEMAS` is a merge path. Nothing in the graph says "and also this". The
routing doc stays the better answer to this particular question, and that is the shape of the
boundary — ripwire finds what the code *does*, `AGENTS.md` records what the team *decided*.

### Results

8 baseline runs and 7 ripwire runs across the six tasks (per-run detail in
[`scripts/ripwire-eval/agent-results.json`](../scripts/ripwire-eval/agent-results.json)).

| | F1 base | F1 ripwire | calls base | calls rw | tokens base | tokens rw | sec base | sec rw |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| T1 | 0.94 | 1.00 | 65 | 52 | 132K | 128K | 421 | 360 |
| T2 | 0.88 | 0.88 | 53 | 59 | 114K | 144K | 449 | 540 |
| T3 | 0.66 | 0.75 | 30 | 38 | 87K | 106K | 236 | 331 |
| T4 | 0.86 | 0.86 | 43 | 24 | 107K | 113K | 351 | 283 |
| T5 | 0.73 | 0.57 | 42 | 27 | 112K | 102K | 354 | 297 |
| T6 | 0.86 | 0.86 | 24 | 19 | 83K | 83K | 183 | 172 |

| Mean over all runs | baseline | ripwire | delta |
| --- | --- | --- | --- |
| Recall | 0.813 | 0.889 | +9% |
| Precision | 0.868 | 0.825 | -5% |
| F1 | 0.804 | 0.824 | +2% |
| Tool calls | 39.1 | 34.0 | -13% |
| Subagent tokens | 101K | 108K | +7% |
| Wall clock (s) | 302 | 308 | +2% |
| Files opened | 25.0 | 19.6 | -22% |
| Bytes of file opened | 326 KB | 197 KB | -39% |

<!-- RESULTS-TABLE -->

## Adoption cost, if we wanted it

One line installs a prebuilt binary (`darwin-arm64`, `darwin-x64`, `linux-*`) into `~/.local/bin`;
building from source needs only CMake and a C++23 compiler and took 4 minutes here on 4 cores. The
same installer symlinks task-shaped skills into Claude Code, Codex, Cursor, Windsurf, Gemini,
opencode and aider, and can register an advisory `PreToolUse` hook that nudges an agent away from
whole-file reads.

The binary is Apache-2.0, has no runtime dependencies, never leaves the machine, and needs no key —
so it carries none of the review burden a hosted context service would. It writes an 18 MB cache
under `TMPDIR`.

The cost that is not free is the agent's attention. The verb table given to the ripwire arm is
~1.9 KB of prompt in every session that carries it, and ripwire's own README is explicit that the
MCP server's schemas cost more than the CLI's shell pipe. On a repo whose `AGENTS.md` already
spends its budget on a routing table, adding a second routing surface is a real trade.

