---
'agent-device': patch
---

When a session bound to an Apple device rejects `--device=<UDID>` whose value is that device's UDID, the conflict error now points to `--udid <UDID>`. `--device` stays a name selector and `--udid` the ID selector.
