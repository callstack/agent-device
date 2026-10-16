# Review a change

Keep reviewed source read-only. Run checks in an isolated checkout if they can modify it. Use [isolated experiments](test-experiments.md) for mutations or base comparisons.

## Reviewing

Review for concrete regressions. Follow callers and siblings as needed to verify changed behavior.
Apply each check only when the change affects its subject. Reopen a resolved concern only when new evidence changes the conclusion.

- Dependencies and ADRs: for each relevant ADR, read its Status and "Rules at a glance" first.
  Read other sections only for the rules that the change touches. Resolve prerequisite conflicts.
  Update or supersede conflicting decisions explicitly.
- Routing and surfaces: trace through daemon and backend to affected entrypoints. Helper tests bypassing the router do not prove dispatch.
- Typed errors: follow reasons from producers through normalization, transport, and consumers. Never replace them with text matching.
- Interaction paths: verify `packages/contracts/src/interaction-guarantees.ts` claims against native code.
  Error-path delegation does not prove success-path parity. Prove both paths reachable before comparing performance.
- Platform-family claims: cover every backend, including Appium and ADB, or name the covered backends.
- Response shape: keep snapshot-wide metadata at response level. Append warnings through the shared builder.
  Preserve compact defaults, bounded arrays, and artifact paths for large evidence.
- Retained compatibility: run `git tag --contains <commit>`. Unreleased shapes have no external compatibility obligation.
- New tests: each must detect a credible production failure. Test doubles must fail at the same seam as production.
- Changed code: flag dead code, redundant guards, casts, narrating comments, and competing owners.

Use CI Size evidence. At about 700 net production lines or 3 kB npm growth, require an independent reviewer to assess a smaller design.
Also assess any new abstraction, dependency, seam, or ownership rule. Weigh gross churn for moves. Explain justified growth.

## Report findings

Report only triggering scenarios: `file:line`, severity, what breaks, and the fix.
If none, say so. Reject incorrect findings with evidence.
Prove claims such as "one reader", "pure move", or "no shim left" with search or `git diff -M90%`.
