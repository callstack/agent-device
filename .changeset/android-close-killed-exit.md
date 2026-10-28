---
'agent-device': patch
---

Fix Android `close` and `open --relaunch` failing with `android-app-close-timeout` on a loaded emulator while the force-stopped app was still exiting. Close now waits up to 10 seconds for the processes it killed to exit and reports a survivor with `details.phase: exit`; a new process still fails with `process` after 2 seconds.
