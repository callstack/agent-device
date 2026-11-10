---
'agent-device': patch
---

Fix the target annotation writer emitting a payload over the 4 KiB ceiling (rejected by its own parser) for escape-heavy labels. After dropping `rect`, the writer now measures again and omits the annotation if it is still over the limit; that action replays without a target check.
