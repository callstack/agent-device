# PR 2279 acceptance evidence

[PR 2279](https://github.com/callstack/agent-device/pull/2279) routes eligible local iOS Simulator snapshots through the AX bridge and the existing TypeScript presenter, with typed XCTest fallback.

Final head: `ae26f7afc064c75c65c71e677d32d77cdf2f9709`. Matched base: `7a2d48d160aaacb582c6f4cde98b6af7531bf7af`.

## Matched warm corpus

120 measured snapshots per revision: 20 on each of the six existing #2189 screen definitions. Both corpora completed with no stops, failed samples, wrong-screen anchors, unreadable trees, or process-generation changes observed by admission. Fixture setup interactions also completed. This is bounded observed evidence, not a guarantee for every app or transition.

| Screen | Base CLI median / p95 ms | Head CLI median / p95 ms | Daemon median ms, base → head | Failed samples, base / head |
| --- | ---: | ---: | ---: | ---: |
| quiet | 122.9 / 143.4 | 99.4 / 124.1 | 46.0 → 24.0 | 0 / 0 |
| list | 291.9 / 308.6 | 206.3 / 225.7 | 211.0 → 127.0 | 0 / 0 |
| nested-scroll | 164.5 / 197.1 | 109.2 / 166.0 | 83.0 → 32.0 | 0 / 0 |
| alert | 220.3 / 318.2 | 137.4 / 163.5 | 124.0 → 54.0 | 0 / 0 |
| system-surface | 188.0 / 279.5 | 133.7 / 154.3 | 106.0 → 51.0 | 0 / 0 |
| xctest-stress | 221.7 / 293.4 | 137.1 / 152.3 | 124.0 → 57.0 | 0 / 0 |

The driver reuses #2189's screen setup, sample admission, PID checks, deep-button controls, measurement extraction, and v1 result schema. It times the same fresh-process `batch` snapshot command on both revisions, sequentially on one dedicated iPhone 17 Pro / iOS 26.2 Simulator. State checks run outside the timed command. Host load was not controlled or randomized; retain all outliers and do not extrapolate these timings into a general speed guarantee. Runner-demand/open latency and proxy acceptance remain #2198 scope.

Every head screen has an initial debug trace proving bridge acquisition followed by TypeScript presentation. Measured responses retain the documented unavailable-hittability warning and no fallback warning. The base uses the prior XCTest route. Public `snapshotDiagnostics` backend counters are not used as producer proof; the request phase traces identify the bridge. Raw CLI responses are in each `observations.json`; statistics and all raw samples are in `samples.json`. Run `python3 verify-corpus.py` to recheck the published corpus. Process checks are performed by the recorded driver during admission; JSON verification does not recreate those live checks.

## Foreground correctness and regressions

`live-foreground-2931cbc944` repeats normal bridge acquisition and a same-process microphone permission dialog: typed `foreground-owner-unverified` fallback publishes exactly five system-dialog nodes. The production runtime is identical to the final head; `provenance.json` lists the intervening test-only paths. `live-foreground-7cf6e7fd38` additionally retains screenshot and request proof of dismissal keeping the generation circuit disabled, followed by relaunch to a new PID and restored bridge acquisition.

`validation/native-capture-guard-proof.md` supersedes the earlier predicate-only record as guard-deletion proof. The real native capture entry point passes five scenarios. Removing PRE makes three cases fail; removing POST makes one case fail. Restoring both passes all five. Final-head iOS CI executed all five cases successfully; its excerpt is retained. Other planted-red records cover process identity and test selection. Both matched results retain the deep-button control: invalid shallow observation fails; full observation detects the changed descendant.

## Gates, review and size

Final-head `pnpm check:affected --run` passed: 746 related test files / 5,691 tests, the additional selected suite, and all runnable repository gates. All final-head GitHub checks passed, including iOS, Android, macOS, Linux, Coverage, Integration Tests and Size. The fixture-build matrix was skipped; the runnable device checks passed. See `validation/ci.json`, `validation/affected-ae26f7afc0.json`, and [iOS run](https://github.com/callstack/agent-device/actions/runs/33990052327).

The [authoritative size run](https://github.com/callstack/agent-device/actions/runs/33990052329) reports +35,845 bytes npm unpacked and +10,359 bytes tarball. Full reports are retained. The independent review accepted the owning route/foreground policy and identified the two now-resolved native-test gaps. The maintainer approved keeping required correctness and regression coverage together over the 1,000-line budget; final scope is 34 files / 1,353 gross lines. This exception does not waive validation. The implementation keeps routing/circuit policy in the Apple owner and reuses the existing presenter and XCTest modal resolution rather than adding parallel policy. Review context is retained in `validation/review-context.json`.

## Historical diagnostics and provenance

`historical/` retains earlier Settings-only diagnostic slices showing the repeated-discovery regression and its correction on the old base. These are not the final matched comparison and must not be combined with it. `provenance.json` records exact source revisions, fixture fingerprint, trusted artifact producer and hashes. No fixture binary is republished. `SHA256SUMS` covers the evidence files.
