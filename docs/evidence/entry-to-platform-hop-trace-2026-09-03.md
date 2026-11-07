# Entry-to-platform hop trace, 2026-09-03

This trace measured the entry-to-platform route depth at commit `27a97ee619`, with the counting rules in [ADR 0023](../adr/0023-end-state-hop-trace.md). The [ordered per-hop chains](https://github.com/callstack/agent-device/blob/0e7df74a1ad724e1deff07ff57f8ec763c883d21/docs/adr/0023-end-state-hop-trace.md) list every file, its role and the deletion-test result. They describe that commit and are not a current file map.

| Route | Hops | After the one endorsed collapse |
| --- | ---: | ---: |
| Android `press` | 41 | 41 |
| iOS `snapshot`, AX bridge arm | 47 | 46 |
| iOS `snapshot`, XCTest runner fallback arm | 49 | 48 |

The one removable hop is the `bindRuntimeCommands` closure wrapper on the shared snapshot path, so only the snapshot counts change.

These counts supersede the earlier 38 (`press`) and 29 (`snapshot`) figures, which had no ordered chain or counting definition. On the `press` route every pass-through hop kept depth; a target of at most 14 hops would have needed the removal of 27 files with cross-cutting daemon responsibilities or necessary bindings.

The ordered chains state 18 files for the fallback arm's own segment but total the arm at 49 (30 shared + 19). The counts above keep the published totals.
