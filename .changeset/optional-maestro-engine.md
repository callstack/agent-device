---
'agent-device': minor
---

Maestro YAML replay, suites, and export now require the optional `@agent-device/maestro` plugin. Run `agent-device plugins add @agent-device/maestro` on each CLI and daemon host that uses these flows, then close your sessions and run `agent-device daemon stop`. Retry your original command to start a daemon with the updated plugin set; flow syntax and arguments stay the same. Native `.ad` replay remains available without this plugin.
