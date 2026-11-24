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

## The 2–3 s deadline variant through the replay route

The review's second scenario asks for the same open under a 2–3 s client or
transport deadline, with the read ending near that deadline instead of 15 s.
That variant is expressible through the replay route: `replay <script.ad>
--timeout 3000` gives the request a 3 s execution deadline
(`resolveCommandDaemonTimeoutMs` adopts the user flag budget verbatim when the
command declares `flag` as its budget source,
`packages/command-registry/src/timeout-policy.ts`), and each replay plan step
re-enters the daemon with the same request id
(`packages/replay-port/src/daemon-port/session-replay-action-runtime.ts`), so
an `open` step reaches `readForegroundBundle` with about 3 s left. (The
direct `open` surface keeps its descriptor deadline — envelope 90 s floor,
daemon result budget 60 s — and its `--timeout` only widens the envelope; the
earlier analysis below still describes that surface.)

### Live run at the PR's code SHA

The run was executed from the worktree at f42463d26 (= 1d6fc063d + docs);
the post-run evidence commits (2b9d87533, 6df63a664) touch docs/evidence
only, so the PR's code SHA stays 1d6fc063d.

After `pnpm build` and `pnpm clean:daemon`, with the app already in the
foreground (`aa dump -l` showed `app name [com.sankuai.dianping]` before the
run) and the same timestamped `hdc` wrapper on PATH via
`HDC_SDK_PATH=/tmp/ad-5055-partb` (sleeps 25 s on every `aa dump -l`):

```
$ printf 'open com.sankuai.dianping --platform harmonyos\n' > /tmp/ad-5055-partb/one-line.ad
$ PATH=/tmp/ad-5055-partb:$PATH AGENT_DEVICE_STATE_DIR=/tmp/ad-5055-partb/state \
  node bin/agent-device.mjs replay /tmp/ad-5055-partb/one-line.ad --timeout 3000 --json
… "success": false, "code": "REPLAY_DIVERGENCE",
  "details": { "reason": "daemon_request_timeout", "timeoutMs": 3000,
               "action": "open \"com.sankuai.dianping\"" }
```

Timeline, request start (events/request ndjson) and wrapper epochs aligned
(the wrapper log is `/tmp/ad-5055-partb/hdc-wrapper.log`):

```
+0.000s  request started
+0.091s  wrapper: hdc -t 77TYD26826028730 shell aa dump -l   (probe read)
+0.093s  wrapper: sleeping 25 s                              (read would hang)
+3.094s  wrapper: next read begins — bm dump -n com.sankuai.dianping
         (the probe's read was cut at +3.0 s by the clamp, not 15 s)
+3.291s  wrapper: aa start … (dispatch never waited on the hung read)
+3.425s  request canceled → settles daemon_request_timeout, timeoutMs 3000
```

The probe's `aa dump -l` read ended about 3 s after the request started
(not ~15 s), no `alreadyForeground` warning was emitted (a hung read claims
nothing), and the whole request settled at the 3 s deadline. A second run of
the same shape with a two-line script (`context platform=harmonyos` + the
same open) reproduced the timeline: probe read starts +0.01 s after request
start, is abandoned at +3.0 s, request canceled at +3.389 s with
`daemon_request_timeout` / `timeoutMs: 3000` and no `alreadyForeground`
claim. The clamp below 15 s is pinned deterministically
by the unit suite (`app-state.test.ts`: deadline +2 s → read timeout ≤ 2000 ms;
spent deadline → no read; deadline-canceled mid-read → no hang), and the
deadline threading into `requestDeadlineAtMs` by
`application-lifecycle-interaction.test.ts`. The scenario-b run above is the
live half of that wiring: the deadline the daemon admitted bounded both reads,
and the probe claimed nothing.

## Re-run of the replay route at the polish head 9e23b8a13

After the review polish (`9e23b8a13`: contract-typed `readForegroundBundle`, one
remaining-read-budget helper beside hdc.ts, the clamp-bounds-the-read comment), the same
replay route re-ran on the same device. The screen was PIN-locked at this run (the 01:58 UTC
scenario-a run rode an unlocked screen); the measured claims do not depend on the screen
state. One mechanism note: a plain `PATH` prefix does not reach the daemon's hdc —
`resolveHdc` (`packages/platform-harmonyos/src/inventory.ts`) prefers the toolchain roots
and resolves an absolute binary — so the wrapper rides the daemon's own `HDC_SDK_PATH`,
the first root checked.

```
$ printf 'open com.sankuai.dianping --platform harmonyos\n' > /tmp/ad5055-lega/one-line.ad
$ PATH=/tmp/ad5055-lega:$PATH HDC_SDK_PATH=/tmp/ad5055-lega \
  AGENT_DEVICE_STATE_DIR=/tmp/ad5055-lega/state \
  node bin/agent-device.mjs replay /tmp/ad5055-lega/one-line.ad --timeout 3000 --json
… "success": false, "code": "REPLAY_DIVERGENCE",
  "details": { "reason": "daemon_request_timeout", "timeoutMs": 3000,
               "action": "open \"com.sankuai.dianping\"" }
```

Timeline, client request start against wrapper epochs (the wrapper sleeps 25 s only on
`aa dump -l`; everything else passes through):

```
+1.062s  wrapper: hdc -t 77TYD26826028730 shell aa dump -l   (probe read; sleeps 25 s)
+3.292s  wrapper: next read begins — bm dump -n com.sankuai.dianping
         (the probe's read lived 2.23 s — cut at the deadline, not 25 s, not 15 s)
+3.454s  wrapper: aa start … (the dispatch never waited on the hung read)
```

The request settled `daemon_request_timeout` / `timeoutMs: 3000` with **no
`alreadyForeground` claim**, CLI wall 3.68 s — the clamp outcome reproduced at the polish
head. Artifacts: `ad-5055-lega/` (wrapper log, replay JSON, request ndjson). A fresh
already-foreground open under a normal deadline on an unlocked screen remains available
to re-record when the device is next unlocked; the scenario-a run at the top of this doc
is the recorded evidence for that leg.
