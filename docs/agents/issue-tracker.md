# Issue Tracker: GitHub

Issues and PRDs for this repo live as GitHub issues in `callstack/agent-device`. Use the `gh` CLI for issue operations.

## Triage scope

External PRs are not task requests in the issue-triage queue. Reading linked PRs to verify an issue's
dependencies is allowed; it does not expand the task into PR maintenance.

## Conventions

Write issues as implementation contracts: purpose, required behavior, observable completion
conditions, and dependencies. Include an API, data shape, or CLI example for boundary changes.

Sandboxed `gh` may lack host login credentials. Retry the focused command with host authentication
access when permitted before treating it as an authentication failure. Do not reconfigure
credentials; report the command and remaining blocker if the retry fails.

For label meanings and state flow, see `docs/agents/triage-labels.md`.

## Dependencies and sequencing

- Treat `Blocked by: ...` lines, linked prerequisite issues, and branch-base notes as part of the issue contract.
- Before scheduling or reviewing work, check blockers and decide whether the work should wait, stack on a prerequisite branch, or explicitly rescope.
- Do not mark an issue ready for implementation while prerequisite semantics are unresolved.
  A dependent PR can be published with its base and blockers explicit; merge-readiness follows
  `docs/agents/pull-requests.md`.
- When closing an umbrella issue, verify child issue states and the key implementation PRs instead of relying only on checked boxes.

For authorized issue publication, use GitHub issues. A skill workflow alone is not authorization
to publish.
