# #2198 slice A corpus: base vs head, local Simulator

Raw `ios-snapshot-benchmark` results behind the comparison posted on callstack/agent-device#2329.

- Target: `ad-bench-2198` (iPhone-class Simulator, `com.apple.CoreSimulator.SimRuntime.iOS-26-2`, UDID `93FC0A0B-CC1F-4F9D-B29A-CEC76A9301BC`), dedicated to this corpus; CI fixture app `com.callstack.agentdevicelab`.
- Host: MacBook Pro (Mac16,8; Apple M4 Pro, 12 cores). Nothing else drove the Simulator during the runs.
- Harness: `scripts/ios-snapshot-benchmark` at e319193ccf (the same copy for both legs; the base worktree ran the head harness against base production code).
- Base production code: `27a97ee619` (`dist` built from it in a separate worktree).
- Head production code: `7616ba222d` (`dist` built from it). `head-cold-first.json` stamps `revision.commit` as `9189275dcb` because that commit was checked out in the worktree when the leg started; it differs from `7616ba222d` only in source that was not rebuilt into the `dist` the leg ran, and its bench scripts are identical. `head-warm-relaunch.json` stamps `7616ba222d`.
- Cells: `cold` and `first-interaction` at 10 samples, `warm` and `relaunch` at 20 samples, six screens (`quiet`, `list`, `nested-scroll`, `alert`, `system-surface`, `xctest-stress`), `--keep-device --skip-package-size`.
- Known-invalid cells on both legs: `first-interaction` on `list` and `system-surface` fail every sample with `AMBIGUOUS_MATCH` because the harness pressed the screen's anchor text, which names two actionable elements there (a harness defect, fixed separately; the re-run of those two cells is published next to this directory).

| File | Leg |
|---|---|
| `base-cold-first.json` | base, cold + first-interaction |
| `base-warm-relaunch.json` | base, warm + relaunch |
| `head-cold-first.json` | head, cold + first-interaction |
| `head-warm-relaunch.json` | head, warm + relaunch |

`SHA256SUMS` lists each file's digest.
