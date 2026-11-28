# The zh-Hans App Tracking Transparency decline, per OS build, 2026-11-28

Evidence for #5117. The built-in table carries two Simplified Chinese wordings of the App Tracking
Transparency decline. Each one needs the OS build and the source it came from, because a run of the
runner sees one build's strings at a time and cannot tell whether the other wording exists.

## The observed wordings

| zh_CN wording | Code points | OS build | Source of the string |
| --- | --- | --- | --- |
| 要求App不跟踪 | 跟 U+8DDF, 踪 U+8E2A | iOS 18.1 | the button label on screen: iPhone 12 Pro Max (iPhone13,4), UDID `00008101-001E34993A7A001E`, `alert get` returned `["要求App不跟踪", "允许"]` — `ios-zh-hans-device-alert-runs-2026-11-24.md` §3 |
| 要求App不追踪 | 追 U+8FFD, 踪 U+8E2A | iOS 27.0 build `24A5423a`, iOS 27.1 build `24A94401` | `plutil -convert json` on each runtime image's `System/Library/PrivateFrameworks/TCC.framework/zh_CN.lproj/Localizable.strings`, key `REQUEST_ACCESS_DENY_kTCCServiceUserTracking` |
| not 要求App不追踪 | — | iOS 26.2 build `23C54` | XCTest Nightly's own assertion output (below) |

The 27.x read, on both images:

```
REQUEST_ACCESS_DENY_kTCCServiceUserTracking = 要求App不追踪
REQUEST_ACCESS_ALLOW_kTCCServiceUserTracking = 允许
```

The wordings differ in the seventh character alone: 追 U+8FFD against 跟 U+8DDF, both followed by
踪 U+8E2A. The vocabulary compares trimmed, lowercased labels, so no normalization bridges them. A
device that shows one matches only a row that carries that exact wording. That is why the table keeps
two rows for `Ask App Not to Track` rather than one.

## What the failing lane proved

XCTest Nightly run
[46108117499](https://github.com/callstack/agent-device/actions/runs/46108117499) (main
`f0b3cb68468555604a2885184685e39477b98252`), job `iOS Runner Full XCTest Suite (iPhone full
suite)`:

```
RunnerTests+AlertLabelVocabularyTests.swift:130: error: -[… testDeviceVocabularyRowsArePairsTheOSShipsForZhHans]
: XCTAssertTrue failed - Ask App Not to Track → 要求App不追踪 is not a pair the OS ships in zh-Hans
```

The same assertion fails on all four scheduled main runs since the test landed: 45547608570,
45755993894, 45940665731 and 46108117499. Each booted the runtime the workflow pins:

```
Selected iPhone 17 Pro (…) from com.apple.CoreSimulator.SimRuntime.iOS-26-2
{ platform:iOS Simulator, arch:arm64, …, OS:26.2, name:iPhone 17 Pro }   build 23C54
```

Two things follow from that run's output. The read succeeded: the job reported exactly one failing
row, and the assertion's loop skipped the 跟踪 row, so the other seven rows are pairs of iOS 26.2's
zh_CN strings. And iOS 26.2 ships no `要求App不追踪` pair for that key. The run names the row it
could not find; it does not name the wording 26.2 does ship, and no 26.2 string file was read here,
so this document does not claim one.

The preceding scheduled run, 45327248552 (2026-11-24, main `ecb2089867`), passed on the same 26.2
runtime. `git merge-base --is-ancestor` settles the difference: `ecb2089867` is not a descendant of
`c543a2604f` (#4859), which added this assertion together with the 要求App不追踪 row, and the first
failing commit `b2d4ec0511` is. The lane's OS never changed; the assertion arrived.

## Why the CI check cannot require every row to be this lane's pair

`testDeviceVocabularyRowsArePairsTheOSShipsForZhHans` is compiled only for a simulated iOS, so each
run sees one build's pairs. A label that shipped two wordings across shipped builds can be a pair of
at most the builds that word it that way. Requiring every row to be this lane's pair therefore fails a
row the table has to keep — which is exactly the failure above, reached one day after #4859 merged.

Both wordings are therefore listed in the check as observed rather than compared to the lane, and the
check keeps holding the other seven rows — the notification and location pairs, the general-purpose
`OK`/`Cancel` rows, and SpringBoard's `Open` row — to this runtime's own strings, on a read asserted
non-empty. Recognition of each observed wording is not left to that exemption:
`testChineseDeviceVocabularyResolvesTheSystemPermissionPrompts` resolves the tracking prompt through
`.device` for both wordings, and its guard is `#if AGENT_DEVICE_RUNNER_UNIT_TESTS` alone, so it
compiles into the nightly iOS bundle, where run 46143098360 executed it, and into the macOS host
bundle. The host lane runs the suite in full, but Apple CI gates that lane on its macOS impact
selector and skips it for a draft, so the nightly, not the host lane, is where both wordings are
proven on every change to the runner. A dropped row fails the prompt test there, so the exemption in
the zh-Hans check cannot hide one.

A per-build attested set was the other option: assert that a wording the table carries beyond the
lane's own pairs is one some named build ships. It adds nothing here. The set of observed wordings is
already closed by the two rows and pinned by the prompt test, so the set and the table would be two
names for the same list.

## What the check does not catch

The two exempted rows are not compared to the lane's strings, so the check cannot confirm which
build ships which of them: a table that attributes 要求App不跟踪 to a build reading 追踪 stays green.
Only a device or runtime image can decide that attribution, and each of the two here comes from one
that did. A third, unobserved wording is still caught, because it is exempted by no entry: planted
as `要求App不追中`, it failed this check on the iOS 27.0 runtime. Dropping either observed row fails
the prompt test, which the nightly lane runs.
