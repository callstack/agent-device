# Review a change

Keep reviewed source read-only.
If checks can modify it, run them in an isolated checkout.

## Reviewing

Review for concrete regressions.
To verify changed behavior, follow callers and siblings as needed.
Apply each check only when the change touches its subject.
Reopen a resolved concern only on new evidence.

- Dependencies and ADRs: for each relevant ADR, read its Status and "Rules at a glance", or its Decision section if it has none.
  Read other sections only for the rules the change touches.
  Resolve prerequisite conflicts.
  Update or supersede conflicting decisions explicitly.
- Routing and surfaces: trace through daemon and backend to the affected entrypoints.
  Helper tests that bypass the router do not prove dispatch.
- Typed errors: follow reasons from producers through normalization, transport, and consumers.
- Interaction paths: verify the claims in `packages/contracts/src/interaction-guarantees.ts` against native code.
  Error-path delegation does not prove success-path parity.
  Before you compare performance, prove both paths reachable.
- Platform-family claims: cover every backend, including Appium and ADB, or name those covered.
- Response shape: keep snapshot-wide metadata at response level.
  Append warnings through the shared builder.
  Keep compact defaults, bounded arrays, and artifact paths for large evidence.
- Retained compatibility: run `git tag --contains <commit>`.
  Unreleased shapes have no external compatibility obligation.
- New tests: each new test must detect a credible production failure.
  Test doubles must fail at the production seam.
- Changed code: flag dead code, redundant guards, casts, narrating comments, competing owners.
- Help and user docs: trace changed behavior claims to code paths. Block unsupported claims.
- Bulk prose rewrites (docs, ADRs, help): get a review from another model provider.
  The reviewer compares each changed sentence with the base. A self-review is not evidence.

Use CI Size evidence.
At about 700 net production lines or 3 kB npm growth, require an independent reviewer to assess a smaller design.
Also assess each new abstraction, dependency, seam, and ownership rule.

For moves, weigh gross churn. Explain justified growth.

## Trust boundaries

Before you write code for a new trust boundary, get a rule and a case table reviewed.
The table names who selects the path, what the kernel resolves, what can change between checks, where bytes first land, which failures keep the action result, and the accepted cases.
If prose, tests, configuration, or dependencies alter the security contract, review again.
If a finding breaks the invariant of the change, fix it at every entry point.
If a finding concerns another destination class or an independent invariant, file or link an issue instead.

## Report findings

Report only triggering scenarios. Include `file:line`, severity, what breaks, and the fix.

With no findings, say so. Refute incorrect findings with evidence.
Prove claims like "one reader", "pure move", or "no shim left" with search or `git diff -M90%`.
