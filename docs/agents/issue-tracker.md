# Issue Tracker: GitHub

Issues and PRDs for this repo are GitHub issues in `callstack/agent-device`. Use the `gh` CLI for issue operations.

## Triage scope

An external PR is not a task request in the issue-triage queue. To verify issue dependencies, you can read linked PRs.
Do not maintain those PRs.

## Conventions

Write each issue as an implementation contract: purpose, required behavior, observable completion
conditions, and dependencies. For a boundary change, include an API, data shape, or CLI example.

If sandboxed `gh` fails with an authentication error, run the same command with host access, if permitted.
Do not reconfigure credentials. If it fails again, report the command and blocker.

For label meanings and state flow, see `docs/agents/triage-labels.md`.

## Current state

When you change a decision or the scope of your issue, post a comment that starts with `Decision: <topic>:`.
After a PR merges on your umbrella issue, post a `Current state:` comment: merged PRs, open PRs, and the next step.
Before you continue work, read all `Decision:` comments. For each topic, the newest comment wins.
On an umbrella issue, also read the newest `Current state:` comment, if one exists.

## Dependencies and sequencing

- `Blocked by: ...` lines, linked prerequisite issues, and branch-base notes are part of the issue contract.
- Before you schedule or review work, examine the blockers. If one is open, decide: wait, stack on its branch, or rescope explicitly.
- If the prerequisite semantics are not resolved, do not mark the issue as ready for implementation.
  You can publish a dependent PR with its base and blockers explicit. Merge-readiness follows `docs/agents/pull-requests.md`.
- Before you close an umbrella issue, verify child issue states and key implementation PRs, not only checked boxes.

A skill workflow alone does not authorize you to publish an issue.
