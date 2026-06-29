# Apple Platform Consolidation — `platforms/apple` with an `AppleOS` leaf axis

> The platform-axis half of the [perfect-shape roadmap](./perfect-shape.md): make the Apple plugin own
> **iOS / iPadOS / tvOS / macOS** today and **visionOS / watchOS** as honest future leaves — a single
> `apple` platform with an `AppleOS` discriminant. Grounded in a 4-investigator survey of the real code.

## TL;DR

`src/platforms/ios/` is **~85% an OS-agnostic Apple-XCTest engine that is merely misfiled and misnamed.**
Of ~14.2k LOC, ~12k is OS-agnostic (the 6,136-LOC runner stack, tool-provider, discovery, snapshot/AX,
screenshot, perf, debug-symbols), and `apple-runner-platform.ts` already models iOS/tvOS/macOS as
first-class runner profiles. The XCTest runner **already builds `ios|macos|tvos` from one Xcode project**,
and one `createAppleInteractor` already serves both `ios` and `macos`. So consolidation is overwhelmingly
**relocate-and-rename, not rewrite** — for iOS/iPadOS/tvOS/macOS. visionOS is real-but-scoped net-new
work; watchOS is **externally blocked** by Apple (no XCUITest UI automation).

**The taxonomy decision:** add an **`AppleOS` discriminant under one `apple` Platform** — do **not** promote
each OS to its own `Platform` literal. Reasons from the code:
- `DeviceTarget` (`mobile|tv|desktop`) is already **cross-platform** — Android TV uses `target:'tv'`, so a
  `tvos` Platform literal would collide with the form-factor axis. (tvOS is *currently* hacked onto
  `target:'tv'`; the fix is a dedicated `AppleOS` leaf, **not** more overloading of `target`.)
- Promoting to literals explodes the ~15 `isApplePlatform` and ~52 `platform==='macos'` sites to enumerate
  six literals each, and breaks the single-bucket `apple` capability/selector model that already works.

## Before / after

```
BEFORE — Apple support is smeared across an "iOS" folder that is really the Apple engine
─────────────────────────────────────────────────────────────────────────────────────────

DeviceInfo (src/kernel/device.ts)
  platform: ios | macos | android | linux | web     ← macOS is its OWN literal …
  kind:     simulator | emulator | device
  target?:  mobile | tv | desktop                   ← … but tvOS = ios + target:'tv'  (asymmetric!)
                                                       'tv'/'desktop' also used by Android (cross-platform)

  resolveApplePlatformName(target) ──► 'iOS' | 'tvOS' | 'macOS'   ← OS name INFERRED late & lossily

core/interactors.ts:  ios ─┐
                    macos ─┴─► createAppleInteractor      (one Apple owner already exists!)

┌─ src/platforms/ios/  (~14.2k LOC — the "iOS" name is a lie: ~85% is the Apple engine) ─────────┐
│  ░ APPLE-SHARED ENGINE (OS-agnostic, ~12k) ░                                                   │
│     runner/ stack ........ 6,136 LOC / 17 files     (speaks JSON to a Swift host w/ #if os())   │
│     apple-runner-platform.ts ► RUNNER_PROFILES = { iOS, tvOS, macOS }   (3 rows)                │
│     discovery · tool-provider · snapshot/xml · screenshot · perf · debug-symbols                │
│  ▓ iOS leaf ▓   touch synthesis · status-bar override · xctrace perf                            │
│  ▓ tvOS leaf ▓  XCUIRemote focus / remotePress                                                  │
│  ▒ macOS leaf — MISLABELED HERE (~797 LOC) ▒  macos-helper · macos-apps · host-provider · scroll │
└───────────────────────────────▲─────────────────────────────────────────────────────────────────┘
                                 │ imports (dependency arrow points BACKWARD)
                  src/platforms/macos/devices.ts = 19-LOC stub

Discovery:  xcrun simctl list ─► filter admits only {ios, tvos} ─► watchOS, visionOS SILENTLY DROPPED
Capabilities: ONE 'apple' bucket + scattered re-derivation
   isNotMacOs ×5 · isIosMobileSimulator · synthesisGestureUnsupportedHint · dispatch hard-throws ×3
   ('macos' string in 52 files · 'tv' in 15)
```

```
AFTER — one 'apple' platform, an AppleOS leaf axis, the engine named for what it actually is
─────────────────────────────────────────────────────────────────────────────────────────────

DeviceInfo
  platform: apple | android | linux | web           ← ios + macos collapse into 'apple'
  appleOs:  ios | ipados | tvos | watchos | visionos | macos   ← NEW discriminant, stored at discovery
  kind:     simulator | device
  target?:  mobile | tv | desktop                   ← UNCHANGED, stays orthogonal (shared w/ Android)

  resolveAppleOs(device) ──► reads appleOs  (fallback: legacy target inference)   ← single seam

Apple plugin  = one instance of the PlatformPlugin registry (perfect-shape.md §5.1),
                owning every leaf OS via appleOs

┌─ src/platforms/apple/ ──────────────────────────────────────────────────────────────────────────┐
│  core/   ░ OS-agnostic Apple engine — MOVED VERBATIM from platforms/ios ░                          │
│    runner/ (6,136 LOC) · tool-provider · discovery (absorbs the old stub, filter widened)          │
│    snapshot · screenshot · perf · debug-symbols                                                    │
│    os-profiles.ts ► RUNNER_PROFILES = { iOS, iPadOS, tvOS, macOS, visionOS, watchOS✗ }  (3 → 6)     │
│  interactor.ts   (from core/interactors/apple.ts)                                                  │
│  os/     ← leaf code ONLY (genuinely per-OS)                                                       │
│    ios/      touch synthesis · status-bar · xctrace                                                │
│    ipados/   aliases ios  (only if iPad-specific features are modeled)                             │
│    tvos/     XCUIRemote focus — NO coordinate tap  (contract differs; NOT flattened)               │
│    macos/    AppKit: helper binary · host-provider · desktop-scroll · menubar/desktop surfaces     │
│    visionos/ NEW — feasible: profile + build case + #if os(visionOS) + real spatial-input QA       │
│    watchos/  ⛔ unsupported sentinel — XCUITest can't drive watchOS (declared, gated at admission)  │
└────────────────────────────────────────────────────────────────────────────────────────────────────┘

Capabilities: per-AppleOS DATA TABLE  (mirrors os-profiles + the Swift #if os() guards 1:1)
   { inputModel, multiTouch, gestures{pinch,rotate,transform}, surfaces, keyboard, orientation }
   ⇒ scattered isNotMacOs / target!=='tv' predicates collapse into one lookup
```

## Per-OS readiness (honest)

| OS | Status | Reality |
|---|---|---|
| **iOS** | works | Reference path. |
| **iPadOS** | works | Rides iOS *identically* (matched by `/ipad/`). Zero runner work; splitting it is a naming/label concern — only worth it if Stage Manager / pointer / Pencil are actually modeled. |
| **tvOS** | works | Functional but modeled as `ios + target:'tv'`. Promotion = **rename to a leaf**; XCUIRemote focus + no-coordinate-tap behavior already exists. |
| **macOS** | works | Same XCUITest project (`build:xcuitest:macos`) **plus** a separate `agent-device-macos-helper` Swift binary for AX surfaces. ~797 LOC already (mis)lives in `platforms/ios`. AppKit, not UIKit — kept as a distinct leaf, not folded into the touch model. |
| **visionOS** | feasible, net-new | XCUITest *does* support visionOS. Needs `xros` in `SUPPORTED_PLATFORMS`, a profile row, a build case, `#if os(visionOS)`, a widened discovery filter, **and real QA** of spatial input (look+pinch, no flat coordinates) + multi-window snapshot. Good first net-new OS to validate the leaf pattern. |
| **watchOS** | blocked by Apple | **XCUITest cannot drive watchOS UI** (no `XCUIApplication`). Not a code gap. Model as an explicit *unsupported sentinel* — do not promise it from this runner. |

## On macOS (the one to think about)

macOS is **AppKit**, the odd one out at the UI-framework level — so it's reasonable to ask whether it
belongs. The code says **include it, as a distinct leaf**, for two reasons:

1. It's already the **same XCUITest project** the iOS/tvOS runner uses (`build:xcuitest:macos`) — it is
   already in the Apple runner, not a separate harness.
2. **~797 LOC of macOS code already lives *inside* `platforms/ios`** (`macos-helper`, `macos-apps`,
   `macos-host-provider`, `desktop-scroll`), and `platforms/macos/devices.ts` is a 19-LOC stub the iOS
   discovery imports — the dependency already points backwards.

So macOS is *already entangled* in the Apple stack; **excluding it would leave the mislabel in place**,
which is worse. Consolidation **normalizes** macOS (today it's the only Apple OS with its own `Platform`
literal while tvOS rides `target`) without **homogenizing** it: its AppKit specifics — the macos-helper
backend, the menubar/desktop/frontmost-app surface model, coordinate-pinch, no multi-touch — stay in the
`apple/os/macos/` leaf. The leaf boundary is exactly what protects the AppKit difference.

## Target shape

```
src/platforms/apple/
  core/         ← the ~12k OS-agnostic engine, moved verbatim from platforms/ios
    runner/     (6,136 LOC, 17 files — never needed to know which Apple OS it drives)
    os-profiles.ts   (apple-runner-platform.ts RUNNER_PROFILES, 3 → 6 rows)
    discovery.ts tool-provider/ snapshot/ screenshot/ perf/ debug-symbols/ apps.ts
  interactor.ts (from core/interactors/apple.ts)
  os/
    ios/ ipados/ tvos/ macos/   ← leaf code only (synthesis / focus / AppKit helper / surfaces)
    visionos/  (new, when pursued)   watchos/  (unsupported sentinel)
```

This is the Apple plugin from the roadmap, now owning *N OS leaves* via `AppleOS`. Capabilities become a
**per-`AppleOS` data table** mirroring `RUNNER_PROFILES` and the Swift `#if os()` guards 1:1, replacing the
scattered `target!=='tv'` / `platform!=='macos'` predicates.

## Sequencing (strangler-fig, low-risk first)

1. **Additive `appleOs`** (non-breaking): add `appleOs?: AppleOS` to `DeviceInfo`, populate it at discovery
   (the runtime/productType is already known there), and make `resolveApplePlatformName` /
   `resolveRunnerPlatformName` prefer it with the existing target inference as fallback. Extend
   `RUNNER_PROFILES` 3 → 6. Instantly makes iOS/iPadOS/tvOS/macOS first-class and unambiguous without
   touching the ~50 `macos`/`isApplePlatform` call sites. *(Aligns with AGENTS.md's "Apple-family target
   changes must keep device.ts, capabilities.ts, dispatch-resolve.ts, ios/devices.ts, ios/runner-xctestrun.ts
   in sync" rule — this step is what makes that rule a single seam instead of a five-file checklist.)*
2. **Relocate macOS** out of `platforms/ios` into `apple/os/macos/` and invert the `macos/devices.ts` stub.
   Self-contained de-scatter; the single biggest mislabel removed.
3. **Move the OS-agnostic core** (`runner/` stack, tool-provider, discovery, snapshot, screenshot, perf,
   debug-symbols, `os-profiles.ts`) `platforms/ios` → `platforms/apple/core` — pure move + re-export.
   Rename `ios-runner/` → `apple-runner/` (cosmetic).
4. **Promote tvOS** from `ios + target:'tv'` to an `apple/os/tvos/` leaf (rename; behavior already exists).
5. **visionOS** as the first net-new OS: profile row + `SUPPORTED_PLATFORMS += xros` + build case +
   `#if os(visionOS)` + widened discovery + **budgeted spatial-input/snapshot QA**.
6. **watchOS** = explicit unsupported sentinel (declared, gated at admission), no runner work.
7. **Per-`AppleOS` capability table** replaces the scattered predicates (after the leaves exist).

Steps 1–4 compose with the roadmap's **Phase 3 (platform plugin)** — the Apple plugin is the first real
`PlatformPlugin`, and it owns the `AppleOS` leaves. Step 1 can land early as additive groundwork.

## Risks / do-not-flatten

- **tvOS has a different interaction contract** (focus-only; `tap(x,y)` returns `UNSUPPORTED` off the
  focused element). A uniform tap across Apple OSes is wrong by design — keep the per-OS capability gates.
- **macOS is a hybrid backend** (XCTest runner *and* the macos-helper binary). Don't fold the helper into
  the runner.
- **visionOS is feasible but unvalidated** — spatial windowing, ornaments, multi-window viewport inference,
  and look+pinch synthesis need real device/sim QA. "Just add a profile row" under-counts it.
- **Snapshot fidelity is uneven** — the deep-RN-tree AX-server fallback is iOS-simulator-only; macOS / tvOS
  / visionOS rely on public XCTest snapshots, so a unified "apple snapshot" has materially different
  reliability per OS.
- **`watchos` must be gated unsupported**, or it surfaces a selectable device with no runner backend.
- The relocation touches ~52 `macos` + ~15 `tv` references — mechanical (move + re-export) but high diff;
  stage as create-re-export → move-leaves → flip-the-stub-inversion-last to keep each step shippable.
