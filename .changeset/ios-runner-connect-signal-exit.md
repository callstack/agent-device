---
'agent-device': patch
---

Fix in-flight `prepare ios-runner` retrying the old runner port when the runner child process is terminated by a signal or the session is invalidated/drained during startup. Signal exits report `xcodebuild_exited_early`, and a draining/stopped session ends the connect wait with `runner_session_draining`/`runner_session_stopped` instead of exhausting the connect timeout.
