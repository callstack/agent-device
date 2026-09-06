# #2198 slice B: controlled-RTT proxy bench, base vs head

Raw `ios-snapshot-benchmark --mode proxy` results behind the comparison posted on callstack/agent-device#2351.

- Target: `ad-bench-2198` (Simulator, `com.apple.CoreSimulator.SimRuntime.iOS-26-2`, UDID `93FC0A0B-CC1F-4F9D-B29A-CEC76A9301BC`), dedicated to this run; CI fixture app; screen `quiet`.
- Host: MacBook Pro (Mac16,8; Apple M4 Pro, 12 cores); 1-minute load average 8–9 during the runs (an earlier attempt under load 45–79 from unrelated processes timed out and was discarded).
- Network: the harness's deterministic conditioner in front of the repository proxy at RTT 0, 20, and 80 ms, unlimited bandwidth, 0 % packet loss; both a persistent Node client and a fresh-process CLI per cell; 20 samples per cell.
- Base production code: `27a97ee619` (`dist` built from it in a separate worktree; harness copied from head).
- Head production code: `318d510769` (slice B head, which merges slice A `e729321dcc`; `dist` built from it).
- Reference profile: `ios-snapshot-proxy-71fb2483f` (#2189 baseline, `bench-golden-v2`, iOS 27.0) uses the same cells and RTT points on a different Simulator and runtime; it is the profile, not a same-host comparison.

| File | Leg |
|---|---|
| `base-rtt.json` | base |
| `head-rtt.json` | head |

`SHA256SUMS` lists each file's digest.
