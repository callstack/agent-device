---
'agent-device': patch
---

Fix the first read after a drag that only shows or hides the soft keyboard waiting about 3.5 s on the iOS Simulator AX bridge, the default Simulator route. A bridge capture now publishes a keyboard fact read from its own tree: the docked-tree band when the tree holds a docked keyboard, and `absent` only when the tree is complete and holds no keyboard trace. A truncated tree stays `unmeasurable`.
