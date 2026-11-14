---
'agent-device': minor
---

Release prerequisite: the plugin remains private and unavailable from npm until a usable package is published through the configured release workflow.

Maestro YAML replay, suites, and export now require the optional `@agent-device/maestro` plugin. After publication, install it on each CLI and store-backed daemon host that uses these flows. Finish sessions and stop the matching daemon. Embedded hosts supply the factory through `startAgentDevice({ plugins })` and close/recreate the returned runtime; they do not use the CLI store or daemon stop command. Retry your original command to start a daemon with the updated plugin set; flow syntax and arguments stay the same. Native `.ad` replay remains available without this plugin.
