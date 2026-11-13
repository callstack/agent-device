---
'agent-device': patch
---

Revyl iOS taps by ref work again while the interface is in the orientation Revyl reported its screen in. Since 0.21.37 they failed with `window-origin-unknown`, because the viewport of a Revyl iOS snapshot came from the tree's root frame and was never reported. A root frame that is exactly the reported screen, at the origin, now establishes the screen origin. Any other root, including one with width and height swapped after a rotation, still refuses coordinate-derived actions.
