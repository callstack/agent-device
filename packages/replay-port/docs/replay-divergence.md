# Replay divergence construction

These contracts supplement [ADR 0012](../../../docs/adr/0012-interactive-replay.md) decisions 1, 4, and 6.
`@agent-device/replay-port` builds the divergence report: its screen, its suggestions, and its `repairHint`.
The [divergence and resume contract](../../ad-replay/docs/divergence-and-resume.md) owns the wire shape, the bounds, and resume.

## Suggestions

Replay uses recorded selector candidates to produce ranked suggestions in a divergence report.
It does not apply them to the script.
`--update` and `-u` do not change this behavior.

The ranking is a total order:

1. Candidates that satisfy more identity components rank first.
   A recorded-id match precedes a role+label match. A role+label match precedes a label-only match.
2. For a verified `target-v1` annotation, equally strong candidates in the recorded `scrollRegion` rank before candidates in other regions.
3. Document order resolves the remaining ties.

Suggestions are deduplicated by node.
A node reached through several recorded selector terms appears once, with its strongest match basis.
The divergence suggestion cap bounds the list.
Response levels affect only report content, never file behavior.
At every level, `--update` performs no rewrite and returns the same bounded suggestions object.
`--level digest` omits entries and includes `suggestionCount`.

## Screen capture scope

`screen.refs` is a filtered, ranked digest of the tree that plain `snapshot` would return at that moment (#1264).
Two guarantees establish this invariant.

**1. Capture scope.** The capture uses the same `captureSnapshot` wrapper as the plain command's backend.
It does not use a parallel single-shot dispatch.
It inherits full-window scope:

- Android uses the snapshot-helper route.
  The existing graceful app-scoped fallback applies only when the helper is unavailable.
- iOS uses the bounded system-modal probe path.
- macOS/Linux use their surface-scoped branches.

It also inherits Android freshness and post-action retries.
Divergence must not use a first stale or app-scoped dump when plain `snapshot` retries for fresh full-window content.
Diagnostic flags use a fixed full-window, non-raw, default-depth policy.
They do not inherit the failed action's `snapshotRaw`, `snapshotScope`, or `snapshotDepth`.
Thus, a failed `snapshot --raw`/scoped/`-d` action must never narrow or reshape the diagnostic tree below what a plain `snapshot` shows.
Only interactive-only policy is carried:
non-rect `get`/`is`/`wait` reads use full content; other actions use interactive content.
Chrome filtering (`collectSettleChromeRefs`) and meaningful-target filtering apply after full capture.
Meaningful targets have label/id or `hittable`.
These filters can remove captured nodes.
The capture itself must never omit content that plain `snapshot` would show.

**2. Ref selection within the cap.** `screen.refs` has a byte bound, not a first-N document-order policy.
Separate-window overlays enumerate after app-window nodes.
A document-order slice could therefore omit the overlay's dismiss target and falsely imply healthy app state.
Before the cap applies, ranking promotes foreign-window hittable nodes ahead of app content.
A foreign window has a non-app `bundleId`.
These nodes include controls that dismiss the covering window.
Each tier otherwise preserves document order.
If a system overlay marks every app node `covered`, the report shows those covered nodes instead of empty `refs`.
Meaningful captured nodes must not produce an empty ref report.

This is a hard invariant: **an agent must never see a healthier `screen` in a divergence report than a plain `snapshot` would show it.**
A covering separate-window system overlay at the moment of capture must appear in `screen.refs` exactly as `snapshot` would present it.
Its actionable/hittable/labeled nodes must survive the filters AND the cap.
Examples include a held volume dialog, persistent quick-settings shade, or permission dialog.
`repairHint` and `suggestions` use the **full captured node list**, never the capped `refs` slice.
Their routing must not treat an app beneath an overlay as healthy.

## Repair hint computation

The daemon computes `repairHint` at divergence time (ADR 0012 decision 6, R3).
The agent never computes it.
It uses two inputs that the daemon already holds:

- the recorded `targetEvidence`: the daemon owns the parsed `target-v1` `ancestry`/`scrollRegion`, *when the diverged action carried an annotation*;
- the screen capture of the divergence: the daemon owns the whole current tree, not the flat, 20-capped `screen.refs` on the wire.

The daemon tests container presence where both inputs exist.
Only the enum crosses the wire; omission of ancestry from the wire does not affect computation.

Capture timing depends on divergence kind.
Target-binding kinds use the pre-action verification tree.
Ordinary `action-failure` uses the post-response capture from the dispatch-thrown path (PR #1223).
That tree answers whether the recorded container currently exists.
No separately stored pre-action tree is necessary.
The mapping covers all four kinds:

| Kind | Condition | Hint |
| --- | --- | --- |
| `selector-miss` (`matchCount: 0`) | Recorded container present | `record-and-heal` |
| `selector-miss` | Container absent or screen differs | `state-repair` |
| `identity-mismatch` (`matchCount >= 1`) | Selector matched incorrect identity | `caution` |
| `identity-unverifiable` | Every case | `manual` |
| `action-failure` | Recorded container present in post-response capture | `record-and-heal` |
| `action-failure` | Otherwise | `manual` |

`caution` applies to `identity-mismatch` because something matched the recorded selector, so a blind re-press may repeat the mistake.
`manual` applies to unverifiable identity because future replays block this step pre-action, so heal-by-doing is a poor fit.
The mapping is total over kind, evidence presence, and capture availability.
Anything not proven safe defaults to `manual`.
Two fail-safes override the container mapping:

- No recorded `targetEvidence` means no container to test, so the hint is `manual`.
  PR #1223 also wraps unannotated actions.
  Thus this case is reachable for `action-failure`, and for any kind on a legacy/unannotated script.
- Sparse or unavailable capture prevents the test, so the hint is `manual`.

## Pre-dispatch capture retry

`captureDivergenceObservation` supplies the pre-dispatch verification tree (#1385).
Immediately after `open --relaunch`, the app can still be in launch or mount operations.
A transient `capture-failed` or `sparse-snapshot` verdict can therefore occur without real divergence.
While the app mounts, Android's snapshot helper returns "insufficient foreground app content", and the capture path throws.
iOS's private-AX fallback can return sparse content under load.
This capture retries with bounded backoff before it returns `identity-unverifiable`.
The fixed delay list has 7 entries and a 12s **DELAY-ONLY** budget.
This corresponds to `wait` landmark verification's existing continued polling (#1349).

The retry is opt-in for each call site (`retryLaunchRace`).
Other `captureDivergenceObservation` callers do not change.
Only the pre-dispatch verification gate in `verifyReplayActionTarget` races a launch this way.
`buildReplayFailureDivergence` and the post-resolution guard-mismatch capture follow established failures.
They do not retry because retries would only delay the decided divergence.

The retry classification matches #1381's content-quality/mechanism distinction in `isUnreadableCaptureContentError`.
The non-throwing `sparse-snapshot` verdict always retries because it already identifies content quality.
A thrown `capture-failed` retries only for these `androidSnapshotHelperFailureReason` codes:

- `empty-helper-output`
- `system-window-only`
- `content-poor-app-window`

`@agent-device/platform-android` attaches those codes to content-poor/system-window-only rejections (`rejectAndroidHelperContentUnavailable`).
They correspond to `AndroidHelperContentRecoveryDecision['reason']`.
The generic `retriable` flag is insufficient.
Android's adb layer also marks mechanism failures retriable: `connection_dropped`, `device_offline`, and `server_version_mismatch`.
The same unchanged adb command can succeed after those failures.
A permanently missing helper artifact (`androidSnapshotHelperUnavailableError`) carries neither signal.
Mechanism failures fail on the first attempt, irrespective of their `retriable` flag.

The 12s **DELAY-ONLY** budget starts at the first capture attempt.
It bounds inter-attempt sleep, not the duration of individual captures.
Capture retains its own platform timeouts.
This loop neither shortens nor duplicates them.
The fixed-length array independently bounds the attempt count.
An instant mocked `sleep` therefore cannot cause a real-time busy loop.
