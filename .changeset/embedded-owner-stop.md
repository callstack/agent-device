---
'agent-device': patch
---

Make `daemon stop` fail with `daemon-owner-embedded` for a live embedded runtime instead of exiting successfully. Close the runtime in its host process with the handle returned by `startAgentDevice()`. Stop sends no shutdown request or signal to embedded or unrecognized owners. It can retire their abandoned registrations after proving the recorded host lifetime exited.

Remove the accidentally released v0.21.29 reasons `host_state_dir_required`, `daemon-shutdown-unconfirmed`, `daemon-embedded-stop-unreachable`, and `daemon-not-embedded`. A missing `stateDir` now returns plain `INVALID_ARGS` with a hint. The external embedded shutdown path is removed. In-process `close()` still returns its shutdown report.
