---
'agent-device': patch
---

Fix commands with an explicit device selector creating a session or executing capture and input against a device another active session already holds. Commands marked `require-owner` now enforce the device claim before capture, input, or session creation, refusing the request with `DEVICE_IN_USE`.
