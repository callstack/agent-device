---
'agent-device': patch
---

Fix the first iOS read after a drag that only shows or hides the soft keyboard waiting about 3.5 s. Post-gesture stabilization now counts the keyboard appearing or going away as a change, so that read settles at the first quiet pair, and such a gesture is no longer reported as `no-effect`.
