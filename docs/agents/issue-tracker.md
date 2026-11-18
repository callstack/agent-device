# Issue Tracker: GitHub

Issues and PRDs are GitHub issues in `callstack/agent-device`. Use the `gh` CLI.

## Triage scope

An external PR is not a task request in the issue-triage queue. To verify issue dependencies, read linked PRs.
Do not maintain those PRs.

## Conventions

Write each issue as an implementation contract: purpose, required behavior, observable completion
conditions, and dependencies. For a boundary change, include an API, data shape, or CLI example.

If sandboxed `gh` fails with an authentication error, rerun it with host access, if permitted.
Do not reconfigure credentials. If it fails again, report the command and blocker.

## Current state

When you change a decision or your issue's scope, post a comment starting with `Decision: <topic>:`.
After a PR merges on your umbrella issue, post a `Current state:` comment: merged PRs, open PRs, and the next step.
Before you continue, read all `Decision:` comments. Per topic, the newest wins.
On an umbrella issue, also read the newest `Current state:` comment.

## Dependencies and sequencing

- `Blocked by: ...` lines, linked prerequisite issues, and branch-base notes are part of the issue contract.
- Before you schedule or review work, examine the blockers. If one is open, decide: wait, stack on its branch, or rescope explicitly.
- Until prerequisite semantics are resolved, do not mark the issue ready for implementation.
  You can publish a dependent PR with its base and blockers explicit. Merge-readiness follows [PR guidance](pull-requests.md).
- Before you close an umbrella issue, verify child issue states and key PRs, not only checked boxes.

A skill workflow alone does not authorize publishing an issue.
