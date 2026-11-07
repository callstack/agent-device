---
'agent-device': patch
---

Refuse `require-owner` commands run under a session this daemon does not hold with `DEVICE_IN_USE` when another session of this daemon holds the device (without reading the host-global claim store). Enforce the in-memory holder guard in the request scope's device access before inspecting device facts or binding, covering every device-touching `require-owner` command. Give `test` the suite-orchestrator claim policy `none` so suite cleanup and recording can act through child case sessions without triggering false device contention. Preserve `NO_ACTIVE_SESSION` for sessionless requests without a device selector.
