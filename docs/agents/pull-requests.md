# Pull Requests

## Publication scope

A request to open or ship a PR includes branch creation, commits, push, and PR creation after
validation; merging and releasing require separate authorization. Apply authorization already given.
If repository or skill guidance still blocks an authorized step, cite the exact instruction and the
blocked action.

## Readiness and validation

Use `docs/agents/testing.md` to select checks and establish regression evidence. Before pushing,
run `pnpm check:affected --run` successfully on the commit being pushed. A serialized gate stage may
run it on the pushed head instead, but its result must be in the PR body before publication is
reported. If a gate fails, diagnose it and rerun after the cause is resolved; report unresolved
failures without claiming validation passed. Rerun a failed CI job once only when its log shows an
infrastructure fault (runner startup, network, device boot); the same failure twice is a finding.

- **Published**: branch pushed, PR opened, and validation recorded at a named commit.
- **Merge-ready**: required checks pass on the actual head, with live evidence for device-facing
  changes. Docs-only and pure-tooling changes do not need device runs. Reporting publication does
  not require waiting for CI.

A local unit run does not establish provider integration or coverage. When those checks are
selected, verify the **Integration Tests** and **Coverage** jobs on the PR head. Run
`pnpm check:fallow --base origin/main` when code-quality or dead-code risk warrants it.

For device-facing changes, fixtures do not replace a live run whose output proves it reached the
route the change adds or modifies; a neighbouring route is not evidence. If blocked, record the
command and device needed and the remaining risk. Close manual sessions using
`docs/agents/device-verification.md` and report incomplete cleanup.

Gross diff budget: 1,000 lines by `git diff --stat origin/main...HEAD`. Rename-only move PRs titled
`refactor(move)` are exempt when `git diff -M90% --stat origin/main...HEAD` proves no material
content change.

## Fresh-context self-review

Before opening a PR, give a reviewer with no implementation context (a subagent or new session)
only the prompt below, the worktree, head, and base ref (`origin/main`); not the diff or a summary.
Fix the findings you accept, rerun the affected checks, and keep a one-line reason for each
rejected finding. Without a way to spawn one, reread the full diff cold against the prompt and say
so.

> You did not write this change. Assume it has bugs and find them. Read `AGENTS.md`, then
> `git diff $(git merge-base <base-ref> HEAD)` and untracked files; open the callers and siblings
> of every hunk. Apply the Reviewing section of `docs/agents/pull-requests.md` and the
> Incident-derived principles. Look for leftovers: narrating comments, guards or try/catch the call
> site does not need, casts, dead code, a second way to do what the code already does one way. Would
> each new test fail if the change were reverted? Report only findings with a triggering scenario:
> `file:line`, severity, what breaks, and the fix. If there are none, say so.

## Commits

Use conventional commit prefixes; no `[codex]` tags. Implementation commits come first. Enforcement
edits — pins, baselines, ownership tables, exports maps, `.fallowrc`, gate manifests — go in one
final commit titled `chore(gates): <what and why>`.

## Rebasing onto a moving `main`

Rebase for conflicts or when upstream changes affect a dependency or gate relevant to the PR
(`pnpm check:affected --base <your-merge-base> --head origin/main`); disjoint upstream changes
alone do not require one. After rebasing, follow the same validation lifecycle on the new head;
retain earlier evidence with its original commit attribution.

## PR body

Ready-for-review by default; draft when requested or intentionally incomplete. Keep the body under
250 words using these sections:

- `## Summary`: changed behavior and why. Include 1-3 CLI/Node/MCP examples for public API changes
  and `Closes #123` when applicable. Note the touched-file count and any expansion of scope.
- `## Validation`: tested commit SHA, relevant results, CI status, and unresolved risks. Name exact
  commands when needed to reproduce evidence or explain a limitation. Use remote-accessible evidence,
  not local paths. For a fix, show `| base <sha> | head <sha> |` output of the same command; captured
  pre-fix output counts. For docs-only changes, explain why runtime validation does not apply.

## Reviewing

- Read linked issue dependencies and relevant ADRs. Resolve prerequisite/base conflicts before
  implementation details. An ADR conflict needs an explicit update or superseding decision.
- For routing or command-surface changes, trace the production path through daemon and backend;
  helper tests that bypass the router do not prove that path. Check CLI, Node.js, daemon, MCP,
  help, and docs where the surface is affected.
- A regression attributed to an earlier PR belongs at the seam that PR missed. For typed-error
  changes, trace producers through normalization and transport and inspect sibling consumers;
  message matching must not replace a lost reason code.
- Check interaction responses for compact defaults, bounded JSON arrays, and artifact paths for
  large evidence; preserve existing warnings and typed error details.
- Use the CI Size workflow for size evidence; local comparisons are not required by default.
  At roughly 700 net production lines (excluding tests, generated data, fixtures, and docs) or
  more than 3 kB npm unpacked growth, an independent reviewer (never the cold-reread fallback) also
  judges whether a smaller owning interface or deletion of superseded code would suffice. Weigh
  gross churn for move-heavy changes. Ask the same of any new abstraction, seam, dependency, or
  ownership rule. These thresholds trigger investigation, not rejection; explain justified growth
  and why a smaller design was rejected.

## Answering review findings

- Fix the rule, not the listed sites. Find what enumerates the sites a finding names (the owning
  helper, type, or registry) and satisfy the invariant there; patching only the named sites starts
  the next round.
- A pattern caught twice is encoded in the first form that fits: a type or structure, a lint rule
  or gate, a regression test, then an `AGENTS.md` principle. Drop the principle once a check
  enforces it.
- A completeness claim carries its proof. Before writing "one reader", "no shim left", "pure move",
  or "behavior unchanged elsewhere", run the grep or `git diff -M90%` that shows it and cite it.
- Test doubles fail the way production fails: fixtures carry the error production produces, and
  stubs throw where the real call throws. Name the mutation that makes the new test fail.
- Push back with evidence when a finding is wrong; do not patch to end the thread.
