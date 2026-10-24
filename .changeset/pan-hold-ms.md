---
'agent-device': patch
---

Add `--hold-ms` to single-pointer `gesture pan`. The pointer holds still at the origin for that long, then moves over `durationMs`, so long-press-then-drag UIs (reorderable lists, web pages with a long-press timer) can be driven by coordinates. The Node client takes `holdMs` on `interactions.pan`, MCP takes `holdMs` on `gesture`, and `.ad` recordings carry it as a flag. The hold plus `durationMs` is capped at 10000ms; `--pointer-count 2` with `--hold-ms` is refused.
