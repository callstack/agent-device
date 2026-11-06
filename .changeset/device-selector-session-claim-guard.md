---
'agent-device': patch
---

Refuse `require-owner` commands run under a session this daemon does not hold with `DEVICE_IN_USE` when another session of this daemon holds the device (without reading the host-global claim store). Enforce the in-memory holder guard in the request scope's device access before inspecting device facts or binding, covering snapshot, wait, find, clipboard, keyboard, trigger-app-event, port-reverse, and record. Preserve `NO_ACTIVE_SESSION` for sessionless requests without a device selector.
