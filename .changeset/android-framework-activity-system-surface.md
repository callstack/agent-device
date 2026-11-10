---
'agent-device': patch
---

Fix Android snapshots failing with "insufficient foreground app content" while a framework activity such as the share sheet (`ChooserActivity` or `ResolverActivity`) covers the app. Those activities run in an application window owned by the `android` package on Android 13 and older, so the snapshot now returns them as a system surface, the same way it returns the notification shade, and the agent can act on or dismiss them.
