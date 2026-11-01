---
'agent-device': patch
---

Fix iOS 26/27 `press`, `click`, and `fill` refusing every control inside a sheet that keeps the screen beneath it in the capture (such as an undimmed sheet) as covered by the sheet's `Toolbar` host. The host now covers the screen beneath the sheet but not the sheet's own controls. A host that encloses a presentation stacked over it still covers everything before it.
