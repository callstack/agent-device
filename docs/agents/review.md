# Review a change

Keep reviewed source read-only.
If checks can modify it, run them in an isolated checkout.

## Reviewing

Review for concrete regressions.
To verify changed behavior, follow callers and siblings as necessary.
Apply each check only when the change affects its subject.
Reopen a resolved concern only when new evidence changes the conclusion.

Make the first review complete.
Report every finding in one pass.
If several findings have one cause and one fix, combine them.
On a later head, verify each open finding against the new head.
Then trace each changed interaction to its caller-visible outcome.
Do not look for new findings in code that an earlier review covered.
On a later head, a design question is advisory.

- Dependencies and ADRs: for each relevant ADR, read its Status and "Rules at a glance" first.
  Without one, read its Decision section, and other sections only for the touched rules.
  Resolve prerequisite conflicts.
  Update or supersede conflicting decisions explicitly.
- Routing and surfaces: trace through daemon and backend to the affected entrypoints.
  Helper tests that bypass the router do not prove dispatch.
- Typed errors: follow reasons from producers through normalization, transport, and consumers.
- Interaction paths: verify the claims in `packages/contracts/src/interaction-guarantees.ts` against native code.
  Error-path delegation does not prove success-path parity.
  Before you compare performance, prove that both paths are reachable.
- Platform-family claims: cover every backend, including Appium and ADB, or name the covered backends.
- Response shape: keep snapshot-wide metadata at response level.
  Append warnings through the shared builder.
  Preserve compact defaults, bounded arrays, and artifact paths for large evidence.
- Retained compatibility: run `git tag --contains <commit>`.
  Unreleased shapes have no external compatibility obligation.
- New tests: each new test must detect a credible production failure.
  Test doubles must fail at the same seam as production.
- Changed code: flag dead code, redundant guards, casts, narrating comments, and competing owners.
- Help and user docs: trace changed behavior claims to code paths.
  Block unsupported claims.
  State outcomes, not internal tuning: tuned constants live in `apple/runner/RUNNER_PROTOCOL.md` by Swift symbol name.
- New trust boundary: before you write code, get a rule and a case table reviewed.
  The table names who chooses the path, what the kernel resolves, what can change between checks, where bytes are first written, which failures keep the action result, and the accepted cases.
  If prose, tests, configuration, or dependencies change the security contract, review again.
  Fix a regression that this change introduces at every entry point.
- Bulk prose rewrites (docs, ADRs, help): get a review from another model provider.
  The reviewer compares each changed sentence with the base. A self-review is not evidence.

Use CI Size evidence.
At about 700 net production lines, 3 kB npm growth, or a third round that adds requirements, require an independent reviewer to assess a smaller design.
Ask the maintainer to re-scope.
Also assess each new abstraction, dependency, seam, and ownership rule.

## Report findings

Report only triggering scenarios. Include `file:line`, severity, what breaks, and the fix.
A finding blocks only if the change breaks the PR's invariant or regresses behavior.
Send other findings to an issue, adjacent code included.
Imprecise wording in text that the PR adds does not block.
It blocks only if a caller who follows it takes an action that fails.
If CI ran the tests green at the reviewed head, do not ask for a local run.
From the third round, send a request that enlarges the requirement to the maintainer, not to the author.

If there are no findings, say so. Reject incorrect findings with evidence.
Prove claims such as "one reader", "pure move", or "no shim left" with search or `git diff -M90%`.
