---
'agent-device': patch
---

Fix `orientation` on a foldable iPhone simulator (iPhone Duo) in a scoped simulator set. It no longer refuses with `unsupported-device-scope`: the fold helper already reaches a scoped set, so the rotation is dispatched through it and confirmed from the panel table's lit-panel `currentOrientation`. The lit panel reads the orientation-picker value plus a fixed per-panel offset, measured on iPhone Duo as 0 degrees on the outer panel and +90 degrees on the inner panel, and the picker value survives a fold. Each dispatch therefore subtracts the lit panel's offset and is re-read until the panel matches, so the first command lands. The fold helper also maps `portrait-upside-down` to the picker's `pud` wire spelling, which the inner panel needs to reach landscape-left; a user target of `portrait-upside-down` stays refused.
