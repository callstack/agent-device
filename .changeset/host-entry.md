---
'agent-device': patch
---

Add `startAgentDevice()` to the main `agent-device` entry to own a daemon inside a Node.js process. Its client configuration pins attaching processes to that runtime, and `close()` returns the shutdown report.
