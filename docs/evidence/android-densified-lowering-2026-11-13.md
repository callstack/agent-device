# Android densified lowering through the shared densifyGesturePath, 2026-11-13

Contributor-reported evidence for #4239's Android side records one pan and one
scroll on hardware. The pan response identifies the Android helper's timed-pan
route. The scroll response reports success without identifying its backend.

## Device and build

- Redmi K60 (Android), adb serial `5p4hqglvpzxshiuw`, Settings app foreground
- Contributor-reported tested commit: `181935c951`, built in the contribution
  worktree, daemon restarted clean; the Android automation helper (0.32.0 build, packaged under
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
produces. The `scroll down` response reports success but does not identify the
backend or sampled route. The contributor reported visible scrolling in both
runs.

## What this evidences

The reported pan reached the Android helper's timed-pan route. The scroll
response cannot establish which backend or lowering executed it. Neither result
shows the cadence of individual timed samples. Cadence equivalence rests on the
pure-function and Android-lowering tests rather than this live run.

The retained notes name `gesture pan --json` and `scroll down`, but do not
preserve the complete argument lists. The pan response records the start point
`(500, 1400)` and displacement `(0, -600)`. These are response facts, not a
reconstruction of the missing invocation.
