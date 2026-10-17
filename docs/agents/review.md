# Review a change

Keep reviewed source read-only.
If checks can modify it, run them in an isolated checkout.

## Reviewing

Review for concrete regressions.
To verify changed behavior, follow callers and siblings as necessary.
Apply each check only when the change affects its subject.
Reopen a resolved concern only when new evidence changes the conclusion.

- Dependencies and ADRs: for each relevant ADR, read its Status and "Rules at a glance" first.
  If it has no "Rules at a glance", read its Decision section.
  Read other sections only for the rules that the change touches.
  Resolve prerequisite conflicts.
  Update or supersede conflicting decisions explicitly.
- Routing and surfaces: trace through daemon and backend to the affected entrypoints.
  Helper tests that bypass the router do not prove dispatch.
- Typed errors: follow reasons from producers through normalization, transport, and consumers.
  Never replace them with text matching.
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
- Bulk prose rewrites (docs, ADRs, help): get a review from another model provider.
  The reviewer compares each changed sentence with the base. A self-review is not evidence.

Use CI Size evidence.
At about 700 net production lines or 3 kB npm growth, require an independent reviewer to assess a smaller design.
Also assess each new abstraction, dependency, seam, and ownership rule.

For moves, weigh gross churn. Explain justified growth.

## Report findings

Report only triggering scenarios. Include `file:line`, severity, what breaks, and the fix.

If there are no findings, say so. Reject incorrect findings with evidence.
Prove claims such as "one reader", "pure move", or "no shim left" with search or `git diff -M90%`.
