# Issue Label Workflow

The skills speak in terms of four canonical triage roles. This file maps those roles to the actual GitHub labels used in this repo.

| Skill role | GitHub label | Meaning |
| --- | --- | --- |
| `needs-triage` | `needs-triage` | New or unreviewed issue; maintainer needs to evaluate it |
| `needs-info` | `needs-info` | Waiting on reporter or external input |
| `ready-for-agent` | `ready-for-agent` | Fully specified, AFK-ready for an agent to pick up |
| `wontfix` | `wontfix` | Will not be actioned after an explicit maintainer decision |

Default flow:

1. New issues get `needs-triage`.
2. Remove `needs-triage` once the issue is understood and valid.
3. Add `needs-info` when reporter or external input is required.
4. Add `ready-for-agent` when the issue is fully specified and can be picked up by an AFK agent with no extra human context.
5. Add `wontfix` only after an explicit maintainer decision.
