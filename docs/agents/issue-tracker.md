# Issue Tracker: GitHub

Issues and PRDs for this repo live as GitHub issues in `callstack/agent-device`. Use the `gh` CLI for issue operations.

## Pull requests as a triage surface

PRs as a request surface: no.

External PRs are not part of the triage request queue. Use `gh pr` commands only when a task explicitly asks for PR review, CI, or PR maintenance.

## Conventions

`gh` authentication may only be available through the user's login shell. In sandboxed agent environments, run GitHub operations through the login shell and request escalation for network/auth access, for example:

```sh
/bin/zsh -lc 'gh issue view <number> --comments'
```

If `gh` still reports that it is not authenticated, do not attempt to reconfigure credentials. Report the exact command that needs to be run from the user's authenticated shell.

- Create an issue with `gh issue create --title "..." --body "..."`.
- Read an issue with `gh issue view <number> --comments`.
- List issues with `gh issue list --state open --json number,title,body,labels,comments`.
- Comment with `gh issue comment <number> --body "..."`.
- Apply or remove labels with `gh issue edit <number> --add-label "..."` or `--remove-label "..."`.
- Close with `gh issue close <number> --comment "..."`.

For label meanings and state flow, see `docs/agents/triage-labels.md`.

## Dependencies and sequencing

- Treat `Blocked by: ...` lines, linked prerequisite issues, and branch-base notes as part of the issue contract.
- Before scheduling or reviewing work, check blockers and decide whether the work should wait, stack on a prerequisite branch, or explicitly rescope.
- Do not mark an issue or PR ready when it duplicates, conflicts with, or depends on unmerged blocker semantics.
- When closing an umbrella issue, verify child issue states and the key implementation PRs instead of relying only on checked boxes.

When a skill says "publish to the issue tracker", create a GitHub issue.
