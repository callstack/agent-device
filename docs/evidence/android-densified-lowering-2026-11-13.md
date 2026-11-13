# Android densified lowering through the shared densifyGesturePath, 2026-11-13

Contributor-reported evidence for #4239's Android side records one pan and one
scroll on hardware. The retained pan notes name the Android helper. The scroll
notes report success without identifying a backend. Raw CLI responses were not
preserved, so the excerpts below are not verbatim response artifacts.

## Device and build

- Redmi K60 (Android), adb serial `5p4hqglvpzxshiuw`, Settings app foreground
- Contributor-reported tested commit: `181935c951`, built in the contribution
  worktree, daemon restarted clean; the Android automation helper (0.32.0 build, packaged under
  this tree's version name) was installed with `adb install -t` before the run

## Retained contributor notes

The original pan notes included `executionProfile: timed-pan`. Android's command
does not emit that field. It is omitted below; it describes the plan selected by
the code, not a field observed in the response.

```json
{
  "kind": "pan",
  "backend": "android-helper",
  "message": "Panned (500, 1400) by (0, -600)"
}
```

```json
{
  "message": "Scrolled down",
  "success": true
}
```

The pan notes name `backend: android-helper`. For a pan plan, the shared planner
selects `timed-pan` and Android lowers its samples before helper dispatch; this is
an inference from the code. The scroll notes do not identify a backend or sampled
route. The contributor reported visible scrolling in both runs.

## What this evidences

The contributor reports Android helper pan dispatch and a successful scroll.
The retained notes cannot establish a response-reported execution profile or
which backend or lowering executed the scroll. Neither result shows the cadence
of individual timed samples. Cadence equivalence rests on the pure-function and
Android-lowering tests rather than these reported runs.

The retained notes name `gesture pan --json` and `scroll down`, but do not
preserve the complete argument lists. The pan response records the start point
`(500, 1400)` and displacement `(0, -600)`. These are response facts, not a
reconstruction of the missing invocation.
