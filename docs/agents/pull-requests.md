# Pull Requests

## Publication scope

A request to ship or open a PR authorizes creating a branch, committing, pushing, and opening the PR
once validation is complete. It does not authorize merging or releasing. Carry those authorized
steps through without asking again; a review-only request authorizes inspection, not edits or
publication. If publication is blocked, finish the reviewable local work and report the blocker.

## Readiness

- Static gates first: required checks pass, `pnpm check:fallow --base origin/main` is clean when
  code-quality/dead-code risk is relevant, CI guards are green, no conflict markers or unmerged
  paths remain.
- A local unit-only run is not CI-green. Use `pnpm test:unit` for the repo unit bundle, or
  `vitest run --project unit-core --project fuzz-worker` directly.
  The **Integration Tests** and **Coverage** jobs run the `provider-integration` project —
  verify those green on the actual PR head.
- Device-facing behavior is not merge-ready without real simulator/emulator/device evidence for the
  changed path. Fixture-backed tests prove contracts; they do not replace a live run that creates
  or observes the artifact/state the feature claims to handle. If live verification is blocked,
  state the blocker and the exact command/device needed, and downgrade the PR to residual risk —
  do not call it ready.
- Command-surface changes preserve CLI, Node.js, daemon, MCP, help, and docs coverage where that
  surface is affected, without duplicating command contracts across layers.
- Runtime output stays agent-friendly: compact defaults, top offenders first for diagnostics/perf,
  bounded arrays in JSON, artifact paths for large raw data, progressive lookup for deeper detail.
- Close every manual `agent-device` session opened during verification
  (`docs/agents/device-verification.md`) and report any cleanup you could not complete.
- Two readiness claims, never blurred. **Published and reported**: the branch is pushed, the PR
  body carries evidence gathered at a named commit, and CI on the head is the authority still to
  come. **Merge-ready**: required checks are green on the actual head and, for device-facing
  paths, the live evidence exists (docs-only and pure-tooling changes owe none). "Don't wait for
  CI" licenses the first claim, not the second — say which one you are claiming.
- Gross diff budget: 1,000 lines by `git diff --stat origin/main...HEAD` (three dots: merge base
  to head, so commits `main` gained since your base never count). The exception is a rename-only
  move PR titled `refactor(move)`, proven by `git diff -M90% --stat origin/main...HEAD` showing
  pure rename/move with no material content diff.

## Validation lifecycle

Apply the red/green requirements in `docs/agents/testing.md` when changing behavior or enforcement.
Use focused checks and review appropriate to the change, then one **successful**
`pnpm check:affected --run` on the exact commit that is pushed. Run it yourself before pushing, or let a serialized gate stage run it on the pushed head and append the exact-head
result to the PR body; either way the body records that result before the PR is reported as
published. A failed attempt is diagnostic, not a stop sign: fix the cause, push the fix, and rerun
until it is clean. Never claim a run you did not see complete on that head; exact-head CI is the
authority from there.

## Commits

Implementation commit(s) come first. Enforcement edits — pins, baselines, ownership tables, exports
maps, `.fallowrc`, gate manifests — land in one final commit titled `chore(gates): <what and why>`.
Reviewers read that commit as enforcement: it decides whether the change is gated at all, never
something to skim past.

## Rebasing onto a moving `main`

`main` has no "require branches up to date" rule; a rebase is not owed to GitHub. Rebase when there
is a conflict, or when the commits `main` gained since your base touch a surface your change
depends on or that decides your gates:

```sh
pnpm check:affected --base <your-merge-base> --head origin/main   # what main gained, by gate
```

If that plan names only files and gates disjoint from yours, the rebase buys nothing but another
full validation cycle. PR-body evidence is stamped with the commit it was gathered at, so a rebase
dates it rather than invalidating it; CI on the new head re-establishes it. A merge queue is the
answer once independent migration units regularly land against each other; until then this rule is.

## PR body

Conventional commit prefixes (`feat:`, `fix:`, `chore:`, `perf:`, `refactor:`, `docs:`, `test:`,
`build:`, `ci:`). No bracketed bot tags like `[codex]`. Ready-for-review by default; draft only
when asked or when the work is intentionally incomplete. Keep the whole body at or under 250 words.

- `## Summary`: user/API behavior, not a file tour. Lead with what changed for operators, clients,
  command authors, or platform behavior. A compact before/after helps when it clarifies the
  workflow or fix. For new or changed public APIs, give 1-3 concrete CLI/Node/MCP examples a
  reviewer can scan. `Closes #123` when applicable.
- `## Validation`: name the tested commit SHA, then a concise statement of what ran and its
  outcome — scenario names, manual device/browser evidence, changed screenshots, CI status, notable
  failures/retries and their outcome. Skip command accounting for routine local gates; name an
  exact command only when it is unusual, manually reproducible evidence, or needed to explain a
  residual risk. Never point at a local file path; the body must stand on its own for a remote
  reviewer. For docs-only changes, say why runtime validation does not apply.
- Call out real tradeoffs, known gaps, and follow-ups; omit boilerplate when there are none.
- Note the touched-file count and whether scope grew beyond the initial command family.

## Reviewing

- Review against the linked issue, not only the diff. State the issue's motivating behavior and
  verify the PR fixes *that*.
- Check relevant ADRs before reviewing architecture, routing, command-surface, platform-boundary,
  diagnostics, or testing-strategy changes. An ADR conflict is a finding unless the PR updates or
  supersedes the ADR explicitly.
- Read dependency notes (`Blocked by: ...`, linked PRs, sibling branches) before judging
  correctness. A base/sequence problem outranks detail review.
- Trace the real production route from command surface through daemon/request routing to the
  platform backend. Tests that mock away the router, or exercise only a helper, do not prove the
  shipped path.
- A fix that cites an earlier PR as the cause adds its regression at the seam that PR missed, not
  at the layer being edited.
- Before adding an error classifier, trace every producer through normalization, wrapping,
  serialization, and transport; inventory sibling consumers and the existing reason-code
  vocabulary; then repair the deepest shared boundary that loses the signal. Message text is not a
  reason code.
- For each key regression test, name what deletion or revert would make it fail. If reverting the
  implementation still passes, the test is vacuous.
- For recurring failures, prefer a design that makes the class impossible at the owning interface;
  keep one small regression as evidence rather than enumerating examples. If a custom guard needs
  repeated exceptions or reconstructs compiler/schema behavior, move the invariant to its source
  of truth instead of extending the guard.
- Check for hidden behavior changes separately from intended refactors: output shape,
  warning/error propagation, artifact paths, fallback/retry tiers.
- Verify tests cover the issue's motivating failure, not just the new abstraction. Prefer
  before/after evidence when an issue reports a concrete divergence.
- Green CI is necessary but insufficient for device-facing or routing-sensitive work.
- Check whether the tightening pass removed code/tests the change made obsolete.
- The CI Size workflow is review evidence; local size comparisons are not required by default.
  Escalate scrutiny at roughly 700 or more net production lines (excluding tests, generated data,
  fixtures, documentation) or more than 3 kB npm unpacked growth. Consider gross additions and
  deletions too, so a move-dominated change is not mistaken for pure growth. These thresholds
  trigger investigation, not automatic rejection: ask an independent reviewer whether a deeper
  owning interface, stronger types, less ceremony, reuse of an existing construction path, or
  deletion of superseded code can make the change materially smaller. The PR should itemize
  justified growth and record why a smaller design was rejected.

## Guidance maintenance

The task-execution and verification guidance applies
[OpenAI's GPT-6 Astra prompting recommendations](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6-astra#prompting-best-practices)
to this repository. Keep model-specific API settings out of contributor instructions; preserve the
repo's gate ownership, context budgets, and explicit publication scope when updating guidance.
