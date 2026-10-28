---
'agent-device': patch
---

Keep a remote recording downloadable when its leased session ends mid-recording (lease expiry, release, or `close`). Teardown finishes the recording and registers the video and gesture telemetry as downloadable artifacts of the lease's tenant, instead of leaving them unreachable in the daemon's temp directory. `GET /artifacts` entries now carry an optional `sessionName` for such artifacts. A later `record stop` replay returns the same artifact ids.
