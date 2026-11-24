# The HarmonyOS open foreground probe's deadline clamp, on the JDY-AL50, 2026-11-24

Live evidence for #5055 (the pre-dispatch already-foreground probe's `aa dump -l`
read clamped to the request deadline). Device: JDY-AL50 (华为畅享 90 Plus),
HarmonyOS 7.0.0.111 (SP10C00E111R4P3), USB serial `77TYD26826028730`. Head
`decd95e8da9be10a9eb9e4b648160e3ce8d00ca7` (the PR's code head; `decd95e8d` is
the empty CI-retrigger commit). Runs through `node bin/agent-device.mjs` after
`pnpm build` and `pnpm clean:daemon`, isolated state dirs under `/tmp`.

## Scenario a — plain open on an already-foreground target, normal deadline

A first open brought `com.sankuai.dianping` to the foreground; the second open
on the same target with the default deadline read the probe, saw the app
already foreground, and answered with the `alreadyForeground` warning:

```
$ AGENT_DEVICE_STATE_DIR=/tmp/ad-5055-evidence/state-a \
  node bin/agent-device.mjs open com.sankuai.dianping --platform harmonyos --json
success: true
data.warnings: ["App was already foreground; open re-activated it without
  restarting. Use --relaunch to restart."]
data.startup.durationMs: 706        (CLI wall 0.84 s; session events.ndjson:
  request.started 01:58:55.941Z → request.finished 01:58:56.651Z, 710 ms)
```

No added probe latency: one `aa dump -l` round trip on this unit answers in
~200 ms (the first open of the same pair measured 4.4 s startup including
session boot; the warm open is 0.7 s with the probe inside it).

## Scenario b — slow foreground reads under the request budget

An `hdc` wrapper earlier on PATH (via `HDC_SDK_PATH=/tmp/ad-5055-evidence`,
the first root `ensureHarmonyToolchainPathConfigured` checks) logged every
invocation, slept 9.5 s on the two inventory `param get` reads, and slept 25 s
on every `aa dump -l`:

```
+ 0.00s  hdc list targets
+ 0.02s  hdc -t 77TYD26826028730 shell param get const.product.name   (sleep 9.5)
+ 0.02s  hdc -t 77TYD26826028730 shell param get const.build.characteristics
+ 9.76s  hdc -t 77TYD26826028730 shell aa dump -l                     (sleep 25 → probe read)
+ 24.78s hdc -t 77TYD26826028730 shell bm dump -n com.sankuai.dianping
+ 24.97s hdc -t 77TYD26826028730 shell aa start -a EntryAbility -b com.sankuai.dianping -m nova
+ 25.77s hdc -t 77TYD26826028730 shell aa dump -l                     (sleep 25 → post-open poll)
```

The probe read started 9.76 s into the request and was killed by its read
timeout 15.02 s later (24.78 s is when the next read began); the post-open
poll's read was killed by the 5 s poll budget. The open still returned success
in 30.6 s wall (startup 20.4 s), with the advisory `open-foreground-probe-unreadable`
warning and **no `alreadyForeground` claim** — a hung read claims nothing and
cannot hold the dispatch past the request budget. No 15-s read outlived the
request; the dispatch was not delayed by the hung reads beyond the bounded
budgets.

## The 2–3 s deadline variant is not expressible on the shipped CLI

The review's second scenario asks for the same open under a 2–3 s client or
transport deadline, with the read ending near that deadline instead of at 15 s.
On the shipped surface, `open`'s request deadline is fixed by the descriptor
registry: envelope 90 s floor, daemon result budget 60 s
(`resolveCommandDaemonBudgetMs` → 60 000, computed mechanically with
`node --experimental-strip-types` against the worktree at this head), and
`--timeout` only widens the envelope (`widenToUserBudget = max(envelope,
timeout + 30 s)`), it never lowers it. The pre-probe route spends at most ~10 s
(the two inventory `param get` reads run in parallel under a 10 s cap), so the
probe's `Math.min(15 s, remaining)` always has ≥ 50 s of room and the clamp
reduces to its 15 s default — exactly what the run above shows. Reaching a
remaining budget below 15 s would need ≥ 45 s of pre-probe spend, which no
shipped `open` route performs. The clamp below 15 s is pinned deterministically
by the unit suite (`app-state.test.ts`: deadline +2 s → read timeout ≤ 2000 ms;
spent deadline → no read; deadline-canceled mid-read → no hang), and the
deadline threading into `requestDeadlineAtMs` by
`application-lifecycle-interaction.test.ts`. The scenario-b run above is the
live half of that wiring: the deadline the daemon admitted bounded both reads,
and the probe claimed nothing.
