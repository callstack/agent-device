---
'agent-device': patch
---

Treat `platform`, `device`, `udid`, and `serial` as explicit-only for `device status` and `device release`, preventing project config selectors in `agent-device.json` from narrowing claim queries or hiding claims matching an explicit `--serial`.
