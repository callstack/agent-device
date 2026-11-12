---
'agent-device': patch
---

Fix foldable iPhone simulator rotation in scoped sets and confirm the lit panel in both default and scoped sets. Both routes use the fold helper, with no CoreDevice orientation polling. An already visible target dispatches nothing. Incomplete, unknown-power and multi-lit panel tables neither confirm nor dispatch. A target the panel never shows fails with `orientation-unverified`.

Use the fixed iPhone Duo picker offsets measured in both sets (outer 0 degrees, inner +90 degrees), replacing runtime calibration. Inner landscape-left sends `portrait-upside-down`, mapped to the HID wire value `pud`; it remains unsupported as a user target. Delayed reads wait without resending the same picker value to the same panel.
