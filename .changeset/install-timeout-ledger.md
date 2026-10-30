---
'agent-device': patch
---

Allow 480 seconds for `install`, `reinstall`, and `uninstall`, and 600 seconds for `install-from-source`, so device startup and artifact preparation leave time for the daemon to return its result. Local Android and iOS install steps now time out after 120 seconds; Android `.aab` builds and installs each have that limit. Android artifact inspection and Apple plist inspection have a 15-second limit, Android uninstall has a 15-second limit, and iOS uninstall has a 20-second limit.

Install into the emulator serial discovered after starting a shutdown Android AVD. This also applies to reinstalls and source installs.
