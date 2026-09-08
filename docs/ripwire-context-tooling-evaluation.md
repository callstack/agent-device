# ripwire evaluation: does a code-context tool help agents work on this repository?

Measured 2026-09-08 against [ripwire](https://github.com/redhat-et/ripwire) v0.5.0, built from
source at `ef6168b18` (GCC 13.3.0, Release+LTO) on a 4-core Linux container. Harness, task
definitions and raw results: [`scripts/ripwire-eval/`](../scripts/ripwire-eval/).

ripwire is a single compiled binary that parses a repository into a ranked call graph and answers
questions about it from the shell — no API key, no embeddings, no index server. The question this
document answers is narrower than "is it good": **does handing it to an agent change what that
agent produces on this repository, and at what cost?**

## Verdict

**Not worth adopting repo-wide today. Worth revisiting if its output gets cheaper.**

Across 24 paired subagent runs on six replayed PRs, an agent given ripwire produced the same change
set as one without it in **8 of 12 pairs**, and the aggregate accuracy difference (+3% F1) is
smaller than the run-to-run variance inside either arm. It did read **30% fewer bytes of source**,
which is the mechanism doing exactly what it claims — but it spent **10% more tokens** doing it,
because the tool's own output is verbose enough to more than repay the file reads it replaces. On
the one change this repository has already documented the answer for (threading a CLI flag), a
maintained routing doc beat the call graph.

What did show up, and is worth keeping in view:

1. **It is consistent where grep is lucky.** On the one task with a non-obvious touch point — a
   scripted provider fake that throws on unscripted calls — both ripwire runs found it and only one
   of two baseline runs did.
2. **The token cost is a fixable implementation detail, not a design limit.** ripwire's
   self-documenting preamble is a *fixed* 1.6–3.1 KB per invocation, up to 62% of a small verb's
   whole response, re-sent on every call. A terse mode would likely flip the token column.
3. **The cheap deterministic verbs stand on their own.** `--recall` answers from 799 KB of markdown
   in 15 KB; `--affected` names the right test files at 2–5 KB when the seed set is narrow.

## What was measured

Three things, two of them with no model in the loop.

1. **Retrieval** — what one ripwire call surfaces from a task description, and what it costs.
2. **Test selection** — given a change's source files, does it name the change's test files.
3. **Agent A/B** — paired subagents localizing six real merged commits, one arm with ripwire and
   one without, scored against the commits themselves.

The benchmark replays six merged `agent-device` PRs. Each task states the change's intent in prose
with no file names; the agent works in a clone pinned at the commit's **parent**, cut with a
shallow fetch so the fix commit is unreachable rather than merely off-limits. Ground truth is the
commit's own file list — files it modified plus files it created — minus `CHANGELOG.md`,
`website/` docs and generated ledgers.

| Task | Replays | Area | Ground-truth files |
| --- | --- | --- | --- |
| T1 | #2366 standalone Maestro `clearState` | `packages/maestro` + daemon adapter + conformance corpus | 17 |
| T2 | #2290 editable-field metadata in digest snapshots | `platform-android` + `kernel` + daemon views + Java helper | 8 |
| T3 | #2356 orientation waits for the display to rotate | `platform-android` + provider scenarios | 5 |
| T4 | #2382 plain-session client reads its own failure record | daemon HTTP server + tenant scope | 8 |
| T5 | #2344 per-poll timeline in wait timeouts | `src/commands/interaction/runtime` | 4 |
| T6 | #2331 detached single-flight Simulator target discovery | `platform-apple` | 3 |

## Fit with this repository

ripwire ingests the tree in **4.9 s cold / 0.74 s warm**, ~196 MB peak RSS, 18 MB of cache on
disk. It reports **4,037 files, 33,002 symbols, 30,651 edges**. TypeScript, Swift, Java and Python
are parsed; the gaps here are 52 `.ad` replay-compat scripts (this project's own DSL — fixture
data, no call graph to lose) and 8 Kotlin files (the Maestro conformance JVM harness). Nothing
load-bearing is dark.

Its one-command quality lens, `--quality-panel`, ranks 105 of this tree's 16,097 function bodies
in 16 KB and 6.3 s — but the head of that list is Swift and Objective-C runner *test* code, not the
TypeScript the 300-line module rule is aimed at. Useful as a lens, not as a gate, which is what its
own documentation says.

For scale: `ripwire .` costs **22.6 KB** (~5.6K tokens) against 33 KB for `README.md` +
`AGENTS.md` + `CONTEXT.md` and 63 KB with `docs/agents/` added. `--recall="<question>"` answers
from the doc corpus in **15.4 KB** where this repo carries **799 KB across 68 markdown files** —
a 52× reduction on "what do we already know about X".

## 1. Retrieval from raw task text (deterministic)

One call per task, fed the task description verbatim, scored on how many ground-truth files it
names. **Recall here is over the change's existing files only** — a retrieval verb ranks what the
tree contains, so a file the commit created is not a hit it could have scored. The agent A/B in
§3 scores the whole change set, added files included, so the two denominators differ on purpose
(the task table above lists the whole set). `for-idents` is the same `--for` verb fed only the identifiers the task text itself puts in
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
ground-truth files were fed to `--affected` — every one ripwire builds a call graph for, this
change set's Android helper Java included, not just its TypeScript; the score is whether the
commit's own test files came back.

Two exclusions keep the denominator honest. Files the commit *created* are out — a selector cannot
name a file that does not exist. And only **test files** (`*.test.ts`) count: a file that merely
lives in a test location — `__tests__/test-utils/fake-adb.ts`, `__tests__/runtime-port-fixtures.ts`,
a provider-scenario world — is a helper, neither a source the change starts from nor a harness
`--affected` could name. Five such helpers appear across the six changes; each task's are listed
under `helpers_not_scored`.

| Task | Expected tests found | Tests selected | Helpers not scored | Bytes |
| --- | --- | --- | --- | --- |
| T1 | 2 / 4 | 65 | 1 | 9.0 KB |
| T2 | 1 / 1 | 185 | 0 | 19.7 KB |
| T3 | 1 / 1 | 5 | 3 | 2.4 KB |
| T4 | 2 / 2 | 24 | 1 | 4.4 KB |
| T5 | 2 / 2 | 18 | 0 | 3.7 KB |
| T6 | 1 / 2 | 2 | 0 | 2.1 KB |
| **Total** | **9 / 12 (75%)** | | 5 | |

Both misses are real. T1's are two `packages/maestro` harnesses the walk did not reach; T6's is
`snapshot-route.test.ts`, which covers the direct caller of the changed module and should have
been a short hop.

Selection breadth is the sharper problem. T2 named **185** test files for a 5-file change: the
seeds reach into `packages/kernel`, whose symbols are called from everywhere, and the walk has no
notion of "this hub is not evidence". At that width the answer costs more to read than it saves.
`--affected` is useful here at 2–24 selected files and not useful at 185.

This does not overlap `pnpm check:affected`, which selects CI *lanes* from a diff. `--affected`
selects test *files* from source files. They answer different questions.

## 3. Agent A/B: does an agent localize better with it?

Two arms over the same six tasks, two replicates each — 24 runs. Identical briefs (the same prose,
the same pinned clone, the same rules, the same JSON deliverable) differing in exactly one
paragraph:

- **baseline**: Read, Grep, Glob, Bash. No code-intelligence tool on the machine.
- **ripwire**: the same tools, plus the binary and its verb table, told to reach for it first.

Both arms ran the same model. Each agent returned the change set it predicted; the harness scored
it against the commit. Cost is the subagent's own token spend, tool-call count and wall clock as
reported by the runtime, not self-estimated.

**Read this half as an archived observation, not as a scripted experiment.** The two deterministic
benches above re-run from one command each; this one does not. The arms were driven by subagents
inside a Claude Code session rather than by a runner in this repository, so repeating it depends on
an agent runtime the harness does not own and on a model that is not pinned here. What is preserved
is everything that made the comparison fair and the recorded runs auditable: the two tooling
paragraphs verbatim (`scripts/ripwire-eval/arms/`), the generator that renders the 12 briefs from
them (`make-briefs.mjs`, which reproduces the briefs the recorded runs were given byte-for-byte),
and the 24 answers as returned (`scripts/ripwire-eval/runs/`). `score.mjs --runs=… --worktrees=…`
re-derives every number below from those files.

### Results

Per task, mean of two runs, shown as `baseline → ripwire`:

| Task | F1 | tool calls | tokens | seconds |
| --- | --- | --- | --- | --- |
| T1 | 0.92 → 0.95 | 59 → 52 | 135K → 146K | 422 → 407 |
| T2 | 0.88 → 0.88 | 52 → 53 | 116K → 137K | 447 → 513 |
| T3 | 0.66 → 0.75 | 30 → 35 | 87K → 109K | 236 → 316 |
| T4 | 0.86 → 0.86 | 40 → 26 | 106K → 110K | 327 → 316 |
| T5 | 0.67 → 0.69 | 36 → 28 | 103K → 108K | 324 → 314 |
| T6 | 0.86 → 0.86 | 24 → 19 | 83K → 83K | 183 → 172 |

Means over all 12 runs per arm:

| | baseline | ripwire | delta |
| --- | --- | --- | --- |
| Recall | 0.834 | 0.861 | **+3%** |
| Precision | 0.850 | 0.855 | +1% |
| F1 | 0.807 | 0.830 | **+3%** |
| Source bytes opened | 334 KB | 234 KB | **-30%** |
| Files opened | 26.2 | 20.9 | -20% |
| Tool calls | 40.3 | 35.7 | -12% |
| **Subagent tokens** | 105.2K | 115.4K | **+10%** |
| Wall clock | 323 s | 340 s | +5% |

Because the runs are paired (same task, same replicate index), the sign counts matter more than the
means at this sample size:

| Metric | ripwire lower | ripwire higher | identical |
| --- | --- | --- | --- |
| F1 | 1 | 3 | 8 |
| Source bytes opened | 10 | 2 | 0 |
| Tool calls | 7 | 4 | 1 |
| Subagent tokens | 3 | 9 | 0 |
| Wall clock | 4 | 8 | 0 |

### Reading the result

**Accuracy is a wash.** F1 moved +3%, and 8 of 12 pairs produced *identical* file sets. On T2, T4
and T6 all four runs returned exactly the same answer — with and without the tool, twice each. The
differences sit in two places:

- **T3** is the one task where the arms genuinely separated, and it separated on *consistency*, not
  on a ceiling. The change needs `test/integration/provider-scenarios/android-world.ts` edited,
  because that scripted fake throws on any unscripted adb call and the fix adds a `dumpsys display`
  probe. Both ripwire runs found it. Of the baseline runs, one found it and one did not (2/5 vs
  3/5) — it read `fake-adb.ts` and `android-world.ts` and concluded neither needed a change.
- **T1**, the 17-file Maestro change, produced the matrix's only perfect run — ripwire, 17/17,
  including the conformance-corpus and fuzz-arbitrary bookkeeping. Its other three runs, both arms,
  all landed 15/17.

T5 is noise, not signal: recall was 1.00 in all four runs and precision swung 0.40–0.67 *within*
both arms, because every run over-predicted a different set of contract and help files.

**It does substitute for reading.** 10 of 12 pairs opened less source with ripwire — ~100 KB less
per run on average, 30% by bytes across 20% fewer files. That is the mechanism working as
advertised.

**And it still cost more tokens.** 9 of 12 pairs spent *more* with ripwire, +10.2K on
average. The saved file bytes did not pay for the tool's own output. Measured directly on this
repository, ripwire's self-documenting XML comment preamble is **1.6 KB on `--for`, 1.7 KB on
`--affected`, and 3.1 KB on `--callers` — 62% of that verb's entire 5.1 KB response**. It is a
*fixed* cost per invocation, so an agent that calls six verbs pays it six times, and it lands
hardest on exactly the cheap, narrow verbs that should be the tool's best value. Whole-file reads
went down; total context did not.

This is the single most actionable finding here, and it is a fixable one: the preamble is
documentation aimed at a first-time reader, re-sent to an agent that has already read it. A
`--terse` mode that emits the header once per session — or not at all — would likely flip the token
column without touching the ranking.

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

## Recommendation

**Do not add ripwire to the repository's agent setup as a default.** The evidence does not support
spending `AGENTS.md` budget on a second routing surface, and the token column is currently
negative. `AGENTS.md` plus `rg` is not the weak baseline this kind of tool is usually measured
against — the declaration-site table, the one-to-one test topology and the typed registries already
do much of the work a call graph would otherwise supply.

**Do keep it as an individual, opt-in tool.** It is a single Apache-2.0 binary, installs in one
line, sends nothing anywhere and needs no key, so the cost of one engineer trying it is a minute.
The verbs worth trying first here are `--recall` (52× cheaper than the doc corpus it searches) and
`--affected` on a narrow seed set.

**Re-run this harness if ripwire ships a terse output mode.** `scripts/ripwire-eval/` is written to
be re-run against a new binary with two commands; the token result is the one number most likely to
move, and it is the one currently deciding the verdict.

**Two findings are worth sending upstream**, since both are measured rather than impressionistic:
the fixed preamble cost per invocation, and `--affected` selecting 185 test files for a 5-file
change once its seeds reach a hub module in `packages/kernel`.

## Caveats

- Six tasks, two replicates. Enough to size an effect, not to make a small one significant. The
  arms are indistinguishable on half the tasks, which is itself the main result.
- The agent A/B is an archived observation: its runs are checked in and re-scorable, but they are
  not re-runnable from this repository (see §3). The retrieval and test-selection benches are, and
  reproduce from the documented commands on freshly cut clones.
- Both arms ran the same model; this measures tooling, not model choice.
- The pinned clones are shallow (20 commits), so ripwire's churn and co-change lenses see a
  truncated history. That handicaps ripwire.
- ripwire indexes were warm when the agents ran; the 4.9 s cold index is reported separately rather
  than folded into per-run wall clock.
- Change-set localization is one job among many. This says nothing about ripwire's refactoring,
  security or quality lenses beyond the single `--quality-panel` run noted above.
