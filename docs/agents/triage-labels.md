# Issue Label Workflow

This file defines five triage roles, each a GitHub label of the same name.

| Label | Apply when |
| --- | --- |
| `needs-triage` | Every new issue; remove once it is understood and valid |
| `needs-info` | Reporter or external input is required |
| `ready-for-agent` | Fully specified; an AFK agent can pick it up with no extra human context |
| `ready-for-human` | Only the Chief of Staff agent applies it |
| `wontfix` | Only after an explicit maintainer decision not to act |

No other agent adds or removes `ready-for-human` on an issue or PR, even when a skill's triage step names it.
