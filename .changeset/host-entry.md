---
'agent-device': patch
---

Add `agent-device/host` with `startAgentDevice()` to own a daemon inside a Node.js process. Its client configuration pins attaching processes to that runtime, and `close()` returns the shutdown report.
