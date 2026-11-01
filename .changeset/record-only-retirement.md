---
'agent-device': patch
---

Stop `record stop` from retiring a session that has gained another owner. A `record start --scope device` that created its own session used to leave that origin set whatever else the session later took on — an app that `open` or a `trigger-app-event` published into the record, an audio probe, a perf capture, a trace, an app log, a device claim, or a remote lease — so the later `record stop` retired the session with no teardown and orphaned those resources with no session left to close them. `record stop` now reads the session record when it decides and ends only the recording once anything else owns the session, which stays releasable by `close`. A session that stayed record-only is still retired by its `record stop`.
