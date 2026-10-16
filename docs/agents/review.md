# Review a change

Keep reviewed source read-only. Run checks in an isolated checkout if they can modify it. Use [isolated experiments](test-experiments.md) for mutations or base comparisons.

## Reviewing

- Read linked dependencies and relevant ADRs. Resolve prerequisite conflicts first. Update or supersede conflicting decisions explicitly.
- Trace routing and surface changes through daemon and backend. Helper tests bypassing the router do not prove dispatch.
  Check affected CLI, Node, daemon, MCP, help, and docs surfaces.
- Trace typed errors from producers through normalization, transport, and sibling consumers. Do not replace lost reason codes with text matching.
- Classify interaction paths in `packages/contracts/src/interaction-guarantees.ts`. Verify each claim against native code.
  Error-path delegation does not prove success-path parity. Prove both paths reachable before comparing performance.
- A platform-family claim covers every backend, including Appium and ADB, or names the covered backends.
- Keep snapshot-wide metadata at response level. Append warnings through the shared builder; never replace prior warnings.
  Check compact defaults, bounded arrays, and artifact paths for large evidence.
- Before retaining compatibility, run `git tag --contains <commit>`. Unreleased shapes have no external compatibility obligation.
- Require each new test to detect a credible production failure. Test doubles must fail at the same seam as production.
- Find dead code, redundant guards, casts, narrating comments, and competing owners. Fix the owning rule, not only named sites.

Use CI Size evidence. At about 700 net production lines or 3 kB npm growth, require an independent reviewer to assess a smaller design.
Also assess any new abstraction, dependency, seam, or ownership rule. Weigh gross churn for moves. Explain justified growth.

## Report findings

Report only triggering scenarios: `file:line`, severity, what breaks, and the fix.
If none, say so. Reject incorrect findings with evidence.
Prove claims such as "one reader", "pure move", or "no shim left" with search or `git diff -M90%`.
Encode repeated findings as types, structure, checks, or tests. Remove prose reminders once enforced.
