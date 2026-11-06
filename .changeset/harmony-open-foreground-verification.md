---
'agent-device': patch
---

HarmonyOS `open` now reads the foreground app for up to 5 seconds after the launch dispatch. When the opened app never holds the foreground, a plain open succeeds with an `open-not-foreground` warning that names the app holding the foreground, or reports that no foreground app is readable; the response carries the typed `timing.foregroundVerification` fact. With `--foreground`, the open fails with `details.reason: open-not-foreground` instead. A lock screen is a typical cause: unlock the device, then run the open again.
