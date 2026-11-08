---
'agent-device': patch
---

Fix Android snapshots marking every earlier sibling layer `interactionBlocked: covered` when a later layer contains a transparent leaf that only has an `identifier` (such as a full-screen `testID` view with `pointerEvents="box-none"`). An identifier-only leaf no longer counts as painting its rect, but it can still be the covered target.
