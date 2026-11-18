# Issue Label Workflow

Each triage role has a GitHub label of the same name.

| Label | Apply when |
| --- | --- |
| `needs-triage` | Every new issue. Remove it once the issue is understood and valid. |
| `needs-info` | Reporter or external input is needed. |
| `ready-for-agent` | Fully specified. An AFK agent can start without more human context. |
| `ready-for-human` | Only the Chief of Staff agent applies it. |
| `wontfix` | Only after an explicit maintainer decision not to act. |

Even if a skill's triage step names `ready-for-human`, no other agent adds or removes it on an issue or PR.
