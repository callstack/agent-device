# Issue Label Workflow

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual GitHub labels used in this repo.

| Skill role | GitHub label | Meaning |
| --- | --- | --- |
| `needs-triage` | `needs-triage` | New or unreviewed issue; maintainer needs to evaluate it |
| `needs-info` | `needs-info` | Waiting on reporter or external input |
| `ready-for-agent` | `ready-for-agent` | Fully specified, AFK-ready for an agent to pick up |
| `ready-for-human` | `ready-for-human` | Valid work, but needs human implementation or judgment |
| `wontfix` | `wontfix` | Will not be actioned after an explicit maintainer decision |

Default flow:

1. New issues get `needs-triage`.
2. Remove `needs-triage` once the issue is understood and valid.
3. Add `needs-info` when reporter or external input is required.
4. Add `ready-for-agent` when the issue is fully specified and can be picked up by an AFK agent with no extra human context.
5. Add `ready-for-human` when the issue is valid but needs human implementation, product judgment, or maintainer ownership.
6. Add `wontfix` only after an explicit maintainer decision.
