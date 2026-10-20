---
'agent-device': patch
---

Make `daemon stop` fail with `daemon-owner-embedded` for a live embedded runtime instead of exiting successfully. Close the runtime in its host process with the handle returned by `startAgentDevice()`. Stop sends no shutdown request or signal to embedded or unrecognized owners. It can retire their abandoned registrations after proving the recorded host lifetime exited.

Remove the `daemon-shutdown-unconfirmed`, `daemon-embedded-stop-unreachable`, and `daemon-not-embedded` reasons shipped in v0.21.29 along with the external embedded shutdown path. In-process `close()` still returns its shutdown report.
