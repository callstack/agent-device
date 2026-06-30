# Phase 3 — PlatformPlugin: progress + plan for the risky remainder

> Tracks the platform-axis work from [perfect-shape.md](./perfect-shape.md) §5.1 / §6 (row "3 · platform
> plugin") and ADR-0009.

## Status

| Step | What | State |
|---|---|---|
| **(a)** | `PlatformPlugin` registry + exhaustiveness + parity tests; route `getInteractor` through it | **✅ shipped (this PR — behaviorless)** |
| **(b)** | Move capability columns + daemon columns onto plugin grants; port `supports()`/`unsupportedHint()` closures verbatim | ⛔ planned — **HUMAN REVIEW ONLY, DO NOT AUTO-MERGE** |
| **(c)** | Unwind macOS and the OS-agnostic Apple engine out of `platforms/ios` into `platforms/apple` | **✅ shipped in #968** |
| **(d)** | Finish the public Apple leaf model: plugin facets, tvOS leaf, final `Platform` collapse, watchOS sentinel | ⛔ planned — **HUMAN REVIEW ONLY, DO NOT AUTO-MERGE** |

## Step (a) — what shipped (behaviorless foundation)

- `src/core/platform-plugin/plugin.ts` — the `PlatformPlugin` type (type-only imports; lazy `createInteractor`
  / `discoverDevices`) + the registry: `registerPlatformPlugin`, `getPlugin` (throws the same
  `UNSUPPORTED_PLATFORM` AppError as the old switch default), `tryGetPlugin`, `registeredPlatforms`.
- `src/core/platform-plugin/register-builtins.ts` — `apple` (owns `ios`+`macos`), `android`, `linux`, `web`
  plugins that WRAP today's `core/interactors/*` factories and the `platform-inventory.ts` branches via lazy
  dynamic `import()`. `BuiltinPluginsCoverAllPlatforms` is the compile-time exhaustiveness assertion (a new
  `Platform` literal without a plugin fails the build).
- `src/core/interactors.ts` — `getInteractor` now `return getPlugin(device.platform).createInteractor(...)`
  after the unchanged provider-device check. Byte-identical (same lazy imports, same factory calls, same
  throw).
- `src/core/platform-inventory.ts` — `WEB_DESKTOP_DEVICE` and `shouldUseHostMacFastPath` exported so the
  web/apple plugins reuse the SAME instance/predicate (no divergent copy).
- Parity test `src/core/platform-plugin/__tests__/parity.test.ts`.

**Contract scope (step-a discipline):** the `PlatformPlugin` type carries ONLY the facets this slice actually
implements and parity-tests — `id`, `platforms`, `familySelector?`, `createInteractor`, `discoverDevices`,
`capability { bucket, supportsByDefault? }`. The daemon-owned columns (`providers` / `recording` / `appLog` /
`perf`) are deliberately NOT declared yet. An earlier draft declared a `recording?: { start(req:
IosSimulatorRecordingRequest): RecordingProcess }` facet; that was REMOVED because it baked the
iOS-simulator provider seam into the contract (it cannot represent the Android / web / macOS-runner /
iOS-device-runner / stop-path recording contracts, which need the daemon recording context, not
`{device,outPath} -> child/wait`). Those facets arrive in step (b), platform-neutral — see §b.3.

**Placement note (deviation from §5.1's `src/platforms/plugin.ts`):** the registry lives under
`src/core/platform-plugin/` — mirroring the existing `src/core/platform-descriptor/` and
`src/core/command-descriptor/` foundations (#905–911), and because everything it wraps today
(`core/interactors/*`, `core/platform-inventory.ts`, the `core/capabilities` bucket) lives in `core/`. Keeping
it in `core/` makes `getInteractor`'s routing and the `createInteractor` wraps `core→core` (the allowed
direction); a `platforms/`-resident registry would have to import `core/interactors/*` backwards at runtime.
The move to `src/platforms/apple/` is part of step (c)'s leaf relocation, not the behaviorless foundation.

**Deliberately NOT done (left hand-authored — parity-tested, not derived):** `PLATFORMS`
(`src/kernel/device.ts:8`) and `parsePlatform` (`src/utils/parsing.ts:109-117`) remain the source of truth.
The parity test proves `registeredPlatforms()` is byte-for-byte equal to both; nothing is derived FROM the
registry yet (per the roadmap's "err toward leaving hand lists"). The CLI `--platform` enum already derives
from `PLATFORM_SELECTORS` (`src/utils/cli-flags.ts:352`), so it is not a hand-sync hazard.

---

## Step (b) — capability + daemon columns onto plugin grants  ⛔ DO NOT AUTO-MERGE

**Principle (perfect-shape §7):** RELOCATE the device-shaped `supports()`/`unsupportedHint()` closures
verbatim; NEVER flatten them to data. Each derived table is pinned by a **table-equivalence parity test that
asserts byte-for-byte equality across the full sample-device matrix BEFORE any hand table is deleted.**

### (b.1) Route the capability-bucket selection through the plugin (pure swap, lowest risk)

- Today: `selectCapabilityForPlatform` (`src/core/capabilities.ts:80-85`) already derives from
  `platformDescriptors` via `deriveCapabilityForPlatform`. The new plugin carries the SAME bucket in
  `capability.bucket` (already parity-tested here against `platformDescriptors`).
- Change: have `isCommandSupportedOnDevice` (`capabilities.ts:87-95`) read the bucket via
  `getPlugin(device.platform).capability.bucket` (falling through `tryGetPlugin` exactly as the §5.1 sketch:
  `if (!plugin) return false`).
- Gate: a parity test asserting `isCommandSupportedOnDevice` is unchanged for the full
  `{command × sample-device}` matrix (reuse `src/__tests__/test-utils/device-fixtures.ts`) before removing the
  `platformDescriptors` indirection. **Keep `platformDescriptors` until proven redundant.**

### (b.2) Port the `supports()` / `unsupportedHint()` device closures verbatim

These encode the irreducible device nuance and live today in `src/core/command-descriptor/registry.ts`:
- `isNotMacOs` (`:41`), `isMacOsOrAppleSimulator` (`:42-43`), `isIosMobileSimulator` (`:44`),
  `supportsAndroidOrIosNonTv` (`:46-47`), `supportsSynthesisGesture`, and
  `synthesisGestureUnsupportedHint` (`:51-`) — the latter encodes **macOS-coordinate-pinch** (`:52`) and
  **tvOS-no-touch** (`:54`, `device.platform === 'ios' && device.target === 'tv'`).
- Used at the `supports:`/`unsupportedHint:` sites (`:81, :145, :212-215, :227, :260, :319, :330-331, :429,
  :440, :463-464, :505-506, :517-518, :530`), notably the two-finger synthesis commands (pinch / rotateGesture
  / transformGesture).
- Plan: move these closures verbatim onto the relevant plugin's `capability.supportsByDefault` (declared but
  unpopulated today) OR keep them on the command facet and have the platform-level default flow through the
  plugin — **do not rewrite the predicate bodies.** Pin with a closure-equivalence test (same inputs → same
  boolean / same hint string) before deleting any hand site.

### (b.3) INTRODUCE the daemon-column facets (platform-neutral) onto the plugin

Step (a) deliberately ships **no** `providers` / `recording` / `appLog` / `perf` facets (an earlier draft's
iOS-shaped `recording` facet was removed — see "Contract scope" above). Step (b) ADDS each facet to the
`PlatformPlugin` type, **typed against a PLATFORM-NEUTRAL, daemon-owned wrapper** — never the
`IosSimulatorRecordingRequest` provider seam — then populates it by wrapping the existing daemon branch, pins
it with a table-equivalence parity test, and only then routes the daemon lookup through `getPlugin(...)`:

| Facet | Hand branch to wrap (file:line) | Neutral wrapper the facet must be typed against | Parity oracle |
|---|---|---|---|
| `providers` | `REQUEST_PLATFORM_PROVIDER_DESCRIPTORS` `src/daemon/request-platform-providers.ts:117-233` (per-platform `resolve` gates) | `() => Partial<PlatformProviderResolvers>` (already platform-neutral) | each resolver returns the same provider/`undefined` per sample device |
| `recording` | `resolveRecordingBackendForDevice` / `stopActiveRecording` `src/daemon/handlers/record-trace-recording-backends.ts:73-101` | a daemon-owned `RecordingBackend` start+stop context carrying **session, deps, fps flag, recording base, resolved output path** for `start` and the **recording tag** for `stop` — NOT `{device,outPath} -> child/wait`; `startIosSimulatorRecording` (`src/daemon/recording-provider.ts:16-18`) is **de-iOS-named** here | same backend tag per device; same stop dispatch per recording tag |
| `appLog` | `resolveLogBackend` `src/daemon/app-log.ts:179-185`; `startLocalAppLog` if-chain `:344-375` | the existing `AppLogStartRequest` (carries device/appBundleId/outPath) + `LogBackend` resolver | same `LogBackend` + same start path per device |
| `perf` | `buildPerfResponseData` `src/daemon/handlers/session-perf.ts:109-131`; `supportsPlatformPerfMetrics` `:324-329`; native-perf Android gate `src/daemon/handlers/session-native-perf.ts:34-39` | the daemon perf request/response context | same metrics/support per device |

**Layering caveat:** these facets reference daemon-owned types, so the facet types must live in / be imported
the right direction. When populated, the plugin's home likely moves to `src/platforms/` (so `daemon →
platforms` stays the allowed direction), which is why step (b.3) is naturally sequenced WITH step (c)'s
relocation. Until each facet is populated AND a real call-site routed through it with a passing parity test,
the daemon branches stay the source of truth and the facet is NOT added to the contract.

---

## Step (c) — Apple filesystem consolidation ✅ shipped in #968

This step retired the stale standalone Apple plan by landing the low-risk relocation it described:

1. **macOS leaf relocation** — `macos-helper`, macOS app discovery, host provider, desktop scrolling, and the
   macOS device stub now live under `src/platforms/apple/os/macos/`. AppKit-specific behavior stays isolated
   and is not flattened into the iOS/tvOS touch model.
2. **OS-agnostic engine relocation** — the runner stack, tool provider, discovery, snapshot, screenshot, perf,
   debug-symbols, and runner profile modules now live under `src/platforms/apple/core/`, and internal imports
   point directly at those Apple modules instead of legacy iOS re-export shims.
3. **visionOS groundwork** — the runner profile, SDK/platform metadata, Xcode supported-platform list, build
   script case, discovery tagging, and Swift interaction guard now recognize visionOS. Live spatial-input QA is
   still future work.
4. **request-count gate removal** — the runner request-count CI gate and `cost.runnerRoundTrips` runtime surface
   were removed because successful `main` runs captured zero runner events, so the signal did not prove runner
   behavior. Apple runner regressions are now guarded by the normal unit/build gates plus live smoke replay.

## Step (d) — remaining Apple leaf/plugin work ⛔ DO NOT AUTO-MERGE

These items are still real work and should not be inferred as done from the filesystem move:

1. **Plugin + interactor placement/facets** — decide whether `core/platform-plugin/` and
   `core/interactors/apple.ts` should move under `src/platforms/apple/` only when the platform-neutral
   `providers` / `recording` / `appLog` / `perf` facets from step (b.3) are ready and parity-tested.
2. **tvOS promotion** — split `ios + target:'tv'` into an explicit tvOS leaf only with tests that preserve the
   XCUIRemote focus-only contract and unsupported coordinate tap behavior.
3. **Final public platform collapse** — changing public `Platform` from `ios`/`macos` to `apple` is the
   highest-diff compatibility step and should remain last.
4. **watchOS sentinel** — watchOS stays out of scope for now; when modeled, it must be an explicit unsupported
   sentinel because XCUITest cannot drive watchOS UI.
5. **Per-`AppleOS` capability tables** — replace scattered Apple predicates only after table-equivalence tests
   prove byte-for-byte behavior for iOS/iPadOS/tvOS/macOS/visionOS sample devices.

**Do-not-flatten (perfect-shape §7):** the iOS XCTest two-finger synthesis (`RunnerSynthesizedGesture`) and
adb/idb leaf code stay untouched; the plugin's job is to stop core/daemon BRANCHING on platform, not to
homogenize the leaves. The `Platform` collapse of `ios`+`macos` → `apple` is the LAST, highest-diff step.
