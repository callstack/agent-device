---
'agent-device': minor
'@agent-device/replay': minor
---

Native `.ad` replay and all test suites require the optional `@agent-device/replay` plugin on the daemon host. Run `agent-device plugins add @agent-device/replay`, finish your sessions and restart that daemon, then retry the original invocation with all its arguments. Remote hosts need their own installation. Embedded hosts supply the version 2 factory through `startAgentDevice({ plugins: [replay()] })` and own runtime replacement. Existing scripts, resume and repair syntax stay the same. Ordinary script recording remains in core.
