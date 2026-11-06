---
'agent-device': patch
---

Fix in-flight `prepare ios-runner` retrying the old runner port when the runner child process is terminated by a signal or the session is invalidated/drained during startup. The connect retry loop now recognises process exits with a signal code as well as session state transitions to `draining` and `stopped`, failing fast with early-exit diagnostics instead of exhausting the connect timeout.
