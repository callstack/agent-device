---
'agent-device': patch
---

Answer `404` instead of `500` when an artifact download, upload ticket, uploaded artifact, or materialized path id was already consumed, has expired, or never existed. The error keeps `code: "COMMAND_FAILED"` and `details.reason: "RESOURCE_EXPIRED"`. Daemon HTTP REST error bodies, such as those on `/artifacts/*` and `/upload/*`, now also carry `reason` when the error has one, and a `hint`. A host lease allocation on `/admin/leases` that a human-control hold refuses now answers `423` instead of `500`. A `/rpc` call that does not stream progress now answers `423` when its handler throws that refusal, as it already did when the handler returned it. A call that streams progress keeps its `200` once it has written progress, and its final envelope carries the failure.
