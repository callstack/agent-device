---
'agent-device': patch
---

Fix the first iOS read after a drag that only shows or hides the soft keyboard waiting about 3.5 s. Post-gesture stabilization now counts the keyboard appearing or going away as a change when both captures read the keyboard from their own tree, so that read settles at the first quiet pair, and such a gesture is no longer reported as `no-effect`. Keyboard facts now carry `treeBound` when the producer read them from the capture's tree: the iOS XCTest runner and the Android helper for `visible` and `absent`, and the docked-tree derivation. A WebDriver (Appium) visibility probe does not, and its captures keep the content-only comparison.
