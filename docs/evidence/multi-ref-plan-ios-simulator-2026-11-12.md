# Multi-ref press plan on an iOS simulator PIN pad, 2026-11-12

Evidence for #4296 at head `edf015fed` (built and run from the contribution
worktree, daemon restarted clean). The plan lowers to ordinary presses; this
run exercises that lowering on real simulator dispatch: a PIN pad page served
to Safari on the booted iPhone 17 Pro simulator (`C1C05FFF-29AD-40D8-94E5-D9CBB25EC6BB`,
iOS 26.5), whose digit keys are real accessibility buttons (`1` `2` `3` `4` `C`)
and whose state row (`ENTERED=... RESULT=...`) plus dot row (`●●●●`) give a
machine-readable oracle for what landed.

## Positive: `press @e12,@e13,@e12,@e13` — the repeated-digit PIN

Fresh `snapshot -i`, then one command (timed):

```json
{
  "sequence": {
    "pressed": 4,
    "refs": ["@e12", "@e13", "@e12", "@e13"],
    "points": [
      { "x": 111, "y": 300 },
      { "x": 201, "y": 300 },
      { "x": 111, "y": 300 },
      { "x": 201, "y": 300 }
    ]
  },
  "ref": "e13"
}
```

Wall time `2104ms`. The page's own state after the run:
`●●●●` and `ENTERED=1212 RESULT=PASS` — the repeated ref pressed the same
key twice, and the screenshot (`positive-final.png`) shows four dots with the
pass row. Per-key resolution and admission ran on every member (the ordinary
press path), which is why the run costs what four presses cost and not less.

## Negative: a later member the frame cannot resolve

Fresh snapshot, then `press @e13,@e999` (`@e999` names nothing):

```json
{
  "success": false,
  "code": "COMMAND_FAILED",
  "message": "Ref @e999 not found",
  "details": {
    "dispatched": "unknown",
    "dispatchedSteps": 1,
    "refPlanKey": "@e999",
    "refPlanPending": [],
    "ref": "e999"
  }
}
```

The request dispatch ledger counted key 1 (`dispatchedSteps: 1`, verdict
`unknown` — the kernel rule: any failure after a dispatched step is never
`no`), and the details name the refused key and the keys that did not run.
`@e13` had already entered a digit; the page held `ENTERED=2`.

## Later-key mutation semantics, observed rather than claimed

Three page variants put a mid-plan mutation between key 1 and key 2 (a
removed key, a disabled key, a system alert raised 50ms after key 1). In all
three the second member resolved to the slot's current point and dispatched —
the tap landed on whatever occupied that point, which is exactly what a
single `press` of the same ref does after the same mutation. The plan adds no
identity re-find and no extra refusal: it inherits the ordinary press's
dispatched-at-point semantics, and callers who need landed verification use
`--settle`/`--verify` as with any press.

## Wall time against the alternatives

Same page, same PIN, three routes:

| Route | Wall time | Outcome |
| --- | --- | --- |
| `press @e12,@e13,@e12,@e13` (one command) | 2104ms | PASS |
| `batch` with four `label=` selector steps | 3058ms | PASS |
| four `(snapshot; press)` caller rounds | 3724ms | PASS |

A fourth route — `batch` with four `ref` steps — failed at digit 2:
`Ref @e13 belongs to an expired ref frame` with `dispatched: 'unknown'`,
`executed: 2` (`batch.json`), because key 1's own mutation expires the frame
the next ref step resolves against. The comma-list plan re-resolves each
member against the fresh frame, which is why the repeated-ref form works
there and fails in a ref batch.

## Notes

- iOS simulator, XCUITest dispatch; no web backend involved (the page is the
  app surface Safari exposes).
- Sessions opened for the run were closed; the local HTTP server ended.
- Local `check:affected --run --base old-origin/main` passes every stage
  except `unit`, which fails only `eager-closure-budgets` — this clone's
  `origin` names a private fork, so the gate reads the wrong merge base;
  pointed at the upstream head for one `pnpm run check:unit`, the chain exits
  0. CI on the pushed head is the authoritative run.
