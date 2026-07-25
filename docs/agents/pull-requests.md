# Pull Requests

## Readiness

- Static gates first: required checks pass, `pnpm check:fallow --base origin/main` is clean when
  code-quality/dead-code risk is relevant, CI guards are green, and no conflict markers or unmerged
  paths remain.
- A local unit-only run is not CI-green. Use `pnpm test:unit` for the repo unit bundle, or
  `vitest run --project unit-core --project subprocess-stub` when invoking Vitest directly. The
  **Integration Tests** and **Coverage** jobs run the `provider-integration` project — verify those
  green on the actual PR head.
- Device-facing behavior is not merge-ready without real simulator/emulator/device evidence for the
  changed path. Fixture-backed tests prove contracts; they do not replace a live run that creates or
  observes the artifact/state the feature claims to handle. If live verification is blocked, state
  the blocker and the exact command/device needed, and downgrade the PR to residual risk rather than
  calling it ready.
- Command-surface changes preserve CLI, Node.js, daemon, MCP, help, docs, and SkillGym coverage
  where that surface is affected, without duplicating command contracts across layers.
- Runtime output stays agent-friendly: compact defaults, top offenders first for diagnostics/perf,
  bounded arrays in JSON, artifact paths for large raw data, progressive lookup for deeper detail.
- Close every manual `agent-device` session opened during verification
  (`docs/agents/device-verification.md`) and report any cleanup that could not be completed.

## PR body

Conventional commit prefixes (`feat:`, `fix:`, `chore:`, `perf:`, `refactor:`, `docs:`, `test:`,
`build:`, `ci:`). No bracketed bot tags like `[codex]`. Ready-for-review by default; draft only when
asked or when the work is intentionally incomplete.

- `## Summary`: user/API behavior, not an implementation file tour. Lead with what changed for
  operators, clients, command authors, or platform behavior. A compact before/after helps when it
  clarifies the workflow or bug fix. For new or changed public APIs, include 1-3 concrete CLI/Node/MCP
  examples a reviewer can scan. `Closes #123` when applicable.
- `## Validation`: meaningful evidence in concise prose — scenario names, manual device/browser
  evidence, changed screenshots, CI status, notable failures/retries and their outcome. Avoid command
  accounting for routine local gates; name an exact command only when it is unusual, manually
  reproducible evidence, or needed to explain a residual risk. For docs-only changes, say why runtime
  validation does not apply instead of writing a command checklist.
- Call out real tradeoffs, known gaps, and follow-ups; omit boilerplate when there are none.
- Note touched-file count and whether scope expanded beyond the initial command family.

## Reviewing

- Review against the linked issue, not only the diff. State the issue's motivating behavior and
  verify the PR fixes *that*.
- Check relevant ADRs before reviewing architecture, routing, command-surface, platform-boundary,
  diagnostics, or testing-strategy changes. An ADR conflict is a review finding unless the PR updates
  or supersedes the ADR explicitly.
- Read dependency notes (`Blocked by: ...`, linked PRs, sibling branches) before judging correctness.
  A base/sequence problem outranks detail review.
- Trace the real production route from command surface through daemon/request routing to the platform
  backend. Tests that mock away the router, or exercise only a helper, do not prove the shipped path.
- For each key regression test, identify what deletion or revert would make it fail. If reverting the
  implementation still passes, the test is vacuous.
- Check for hidden behavior changes separately from intended refactors: output shape,
  warning/error propagation, artifact paths, fallback/retry tiers.
- Verify tests cover the issue's motivating failure, not just the new abstraction. Prefer
  before/after evidence when an issue reports a concrete divergence.
- Green CI is necessary but insufficient for device-facing or routing-sensitive work.
- Check whether the tightening pass removed code/tests the change made obsolete.
