---
'agent-device': patch
---

Accept `--device=<UDID>` for a session bound to an Apple device when the UDID is that bound device's. Previously only the device name matched, so a request that named the bound device by its UDID failed with `INVALID_ARGS`. Commands that re-resolve an explicit selector resolve that value as the bound device's UDID. A different device is still rejected.
