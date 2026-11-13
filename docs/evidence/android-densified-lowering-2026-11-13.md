# Android densified lowering through the shared densifyGesturePath, 2026-11-13

Evidence for #4239's Android side: the reshaped lowering
(`lowerAndroidTouchPlan` calling the shared `densifyGesturePath`) ran on
hardware — one pan and one scroll — and both strokes executed through the
densified Android helper path.

## Device and build

- Redmi K60 (Android), adb serial `5p4hqglvpzxshiuw`, Settings app foreground
- agent-device head at this commit, built in the contribution worktree, daemon
  restarted clean; the Android automation helper (0.32.0 build, packaged under
  this tree's version name) was installed with `adb install -t` before the run

## The runs

```json
{
  "kind": "pan",
  "backend": "android-helper",
  "executionProfile": "timed-pan",
  "message": "Panned (500, 1400) by (0, -600)"
}
```

```json
{
  "message": "Scrolled down",
  "success": true
}
```

`gesture pan --json` names `backend: android-helper` and
`executionProfile: timed-pan` — the timed densified dispatch the lowering
produces — and `scroll down` succeeded through the same plan builder. The
screen visibly scrolled in both runs.

## What this evidences

The shared `densifyGesturePath` rewiring is behavior-preserving on the Android
transport: the sampled-path rule it owns still produces the timed interior
samples the helper's recognizer consumes, at the same cadence the Android
lowering produced before the rewiring. CI covers the pure function and the
lowering; this run covers the live dispatch path on hardware.
