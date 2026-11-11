---
'agent-device': patch
---

Fix `orientation` on a foldable iPhone simulator (iPhone Duo) in a scoped simulator set. It no longer refuses with `unsupported-device-scope`: the fold helper already reaches a scoped set, so the rotation is dispatched through it and confirmed from the panel table's lit-panel `currentOrientation`. Because the guest applies each orientation-picker event relative to the previous picker value (the lit panel reads picker + a fixed per-panel offset, +90 degrees on the inner panel), each dispatch is chosen for the turn still needed and re-read until the panel matches, so the first command lands. The fold helper also maps `portrait-upside-down` to the picker's `pud` wire spelling, which the delta dispatch needs to reach every orientation; a user target of `portrait-upside-down` stays refused.
