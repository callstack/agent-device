---
'agent-device': minor
---

Plain `close` now stops the local simulator or emulator that its own session `open` booted, so a session leaves the device as it found it. A device that was already running when the session opened keeps running, and physical and provider-owned devices are never stopped this way. The stop is reported in `data.shutdown`, the same field `close --shutdown` reports.

This is a default change. `close --shutdown` keeps its meaning and still stops a device the session did not boot. A daemon policy that denies `device-shutdown` blocks both stops: there, `close --shutdown` fails with `DAEMON_POLICY_DENIED`, and a plain `close` succeeds and says in `warnings` that it left the device running. A close that stops a device no longer keeps that simulator's iOS runner warm for the next `open`.
