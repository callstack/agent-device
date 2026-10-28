---
'agent-device': patch
---

Fix WebDriver fill failing before tapping the target because it unnecessarily reads the previously focused field's geometry.
