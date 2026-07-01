# agent-device — The Perfect Shape

> An architecture review + target design, produced from a 31-agent survey of the codebase
> (13 subsystem maps, 6 debt hunts, 5 architecture visions, 3 judges, 4 prototypes).
> Every claim is grounded in real `file:line` evidence. Read-only analysis — nothing here was applied.

---

## 0. TL;DR

agent-device is a healthy ~100k-LOC codebase with **one structural disease expressed on two axes**:
identity is *smeared across many hand-synced tables* instead of owned in one place.

- **Adding a platform touches ~90 files** because there is **no Platform plugin contract** — `Platform`
  is a bare string union re-discriminated by **231 open-coded branches** across ~90 files outside `platforms/`
  (the daemon alone: 57 files).
- **Adding a command touches ~24 files** because **a command is not a single object** — its identity is
  restated in **~10 stringly-keyed tables** (dispatch switch, capability matrix, daemon registry, batch
  allowlist, `client-types.ts`, …), even though a *half-finished declarative spine* (`CommandFamilyFacet`)
  already auto-derives CLI + MCP + batch from one source and just **stops at the command-surface boundary**.

The cure is **two registries** — a `CommandDescriptor` table and a `PlatformPlugin` registry — from which the
hand-synced tables *derive*, plus a **typed-result spine** that replaces `Record<string,unknown>` bags. Done in
the right order (command-first, because its typed-result seam is the safety net the platform unwind needs),
this is a **strangler-fig migration of pure identity tables** — never a rewrite of the genuinely
toolchain-specific leaf code (XCTest synthesis, adb, Maestro replay), which stays exactly where it is.

**Honest scope:** the headline "90 files → 3" is *wiring* cost, not *total* cost. Writing a correct
XCUITest/adb-equivalent interactor for a new platform is thousands of irreducible LOC. The registries make the
wiring cheap and make *half-wired* platforms a compile error — they do not make platforms cheap. Net code
reduction is real but modest (~**-1k to -3k LOC**, dominated by deleting the `client-types.ts` mirror); the
*real* prize is **files-per-change** and **type safety**, not raw line count.

**Decision records:** the two axes are now ADRs — [ADR 0008](../docs/adr/0008-command-descriptor-registry.md)
(command descriptor, composing with ADR 0003) and
[ADR 0009](../docs/adr/0009-apple-platform-consolidation.md) (Apple / `AppleOS`).
**Status (2026-06):** Phase 0 (type-safety, parse-at-boundary, derived allow-lists, `AppleOS` groundwork,
replay derivation), the Tier-A dedup sweep, and the Apple filesystem consolidation are merged. The next gateway
is the command-descriptor spine (§5.2, ADR 0008); everything substantive cascades from it.

---

## 1. Mind map — the codebase today

```
                                 ┌──────────── INTERFACES ────────────┐
                  CLI (bin→cli.ts, cli/, utils/cli-*)   MCP (mcp/)   batch (batch.ts, core/batch.ts)
                                 └──────────────────┬──────────────────┘
                                                    │
                     COMMAND SURFACE  commands/ (90 files, 12k) · command-catalog.ts · contracts.ts
                       └── commands/family/  ← HALF-FINISHED declarative spine (derives CLI+MCP+batch)
                                                    │   ...stops here. Everything below is hand-synced.
                                                    ▼
                       CORE DISPATCH  core/ (5k)   dispatch.ts (24-arm switch, default:throw)
                                       capabilities.ts (matrix keyed apple/android/linux/web)
                                                    │      ↑ leaks: ~16 `await import('../platforms/*')`
                                                    ▼        + ~15 device.platform branches in dispatch*
                       DAEMON  daemon/ (29k)   daemon-command-registry · session-store · request-router
                         └── handlers/ (66 files, 14k)   ← 22 verbatim UNSUPPORTED guards, 13 "No active
                              │                            session" literals, recordAction inlined ×24
                              │   'generic' route is DISOWNED → request-generic-dispatch.ts (outside handlers/)
                              ▼
                       PLATFORMS  platforms/ (29k)   ios 14k ·· android 11.6k ·· macos 19 LOC(!) ·· web/linux
                         ▲  Interactor (core) vs AgentDeviceBackend (backend.ts): TWO contracts, same ~30 ops,
                         │  glued by a stringify→re-parse round-trip. macOS hides 697 LOC inside platforms/ios.
                         │
       ┌─────────────────┴────────── CROSS-CUTTING / UNOWNED ──────────────────────────┐
       │  ~8k LOC client/transport/remote/cloud/tunnel/metro UNFOLDERED at src/ root     │
       │     (the `daemon-` prefix co-locates client driver + server bootstrap + proxy)  │
       │  utils/ (97 files, 13.5k) = grab-bag: 3k CLI parser + 1.8k screenshot-diff +    │
       │     AX-snapshot domain + the CANONICAL device.ts (imported by 92–95 modules)    │
       │  compat/maestro (5.5k) = the LOAD-BEARING .ad replay engine (KEEP)              │
       └────────────────────────────────────────────────────────────────────────────────┘
```

**Subsystem ownership scorecard** (what each owns well vs. where ownership leaks):

| Subsystem | Owns well | Leaks / debt |
|---|---|---|
| CLI | argv tokenizing, zero-load fast paths, remote-lease lifecycle | `runCli` 340-line god fn; special commands routed by string `if`-ladder; 2 divergent deferred-command sets |
| MCP | tool generation from the catalog | hand-rolled inbound validation; `jsonRpcRequestSchema` exists but is **dead**; `params as unknown as Partial<DaemonRequest>` |
| Command surface | the family facet (CLI+MCP+batch derive from it) | spine stops at surface boundary; identity restated downstream ×10 |
| Core dispatch | capability matrix; interactor selection seam | 24-arm string switch; **leaks platform knowledge** (dynamic imports + branches) |
| Daemon | routing/registry/session/admission | hand-rolled per-handler boilerplate; 'generic' family disowned; dual finalize |
| Platforms | genuinely toolchain-specific leaf code | macOS hidden in iOS; two parallel platform contracts; 231 branches *outside* the dir |
| Client/remote | transport, leases, tunnels, cloud | **unfoldered at src root**; `client-types.ts` (1027 LOC) is a 4th copy of the contract |
| utils | real cross-cutting helpers | hosts 3 full subsystems + the canonical domain types |

---

## 2. Diagnosis — one root cause, two axes

### Axis A — No `CommandDescriptor` (the command smear)

A command's identity is restated, by hand, in **~10 places that must agree**:

```
PUBLIC_COMMANDS (command-catalog.ts)         core/dispatch.ts  case 'x':  (switch, default: throw)
commands/*/metadata.ts  name                 daemon-command-registry.ts  descriptor
commands/family facet                        batch-policy.ts  STRUCTURED_BATCH_COMMAND_NAMES
cliReader + daemonWriter                     capabilities.ts  matrix entry
client-types.ts  Options/Result interface    client.ts  executeCommand wrapper
```

Adding a command = synchronized edits to all of them, with **zero compile-time agreement** between them.
The arg shape is serialized/deserialized **4 times** (metadata field map → cliReader → daemonWriter → handler
re-reads positionals). The gesture set is retyped in **3 files**. The dispatch `default: throw` means a
missing/renamed command **compiles fine and fails only at runtime**.

> The good news: `commands/family/registry.ts` already proves the cure works — `commandFamilies` derives MCP
> tools, the CLI schema, and the batch writer from **one array**. The fix is to *extend* this proven seam, not
> invent one.

**Compose, don't collapse (ADR 0003).** "One registration" must **not** become "one flat public object that
owns everything." Daemon route/policy is a deliberately separate, internally-owned concern
([ADR 0003](../docs/adr/0003-daemon-command-registry.md)). The descriptor **composes facets owned by their
domains** — a public `surface` facet (`src/commands/**`), a `capability` facet (`src/core/capabilities`), and a
`daemon` facet **owned under `src/daemon/`** — and *projects* each into its consumer. The daemon registry stays
the sole exposer of its predicate interface (`isLeaseAdmissionExempt`, `shouldLockSessionExecution`, …); only how
its backing table is *built* changes, never how it is *read*. See §5.2 for the binding invariants.

### Axis B — No `PlatformPlugin` (the platform smear)

`Platform` is `'ios' | 'macos' | 'android' | 'linux' | 'web'` (a bare union in `utils/device.ts`). **231
branches** in ~90 files re-discriminate it. Partial seams exist (the `Interactor` interface; the
`request-platform-providers` descriptors) but each of capabilities, device-discovery, providers, recording,
app-log, perf, surfaces, the `--platform` enum, and client-normalizer validation **re-branches independently**.
Three allow-lists (`PLATFORMS`, the CLI `--platform` enum, the client-normalizer validator) must be **hand-synced**.

Concrete tells:
- `capabilities.ts` `CommandCapability` **hardcodes** `apple/android/linux/web` as keys; the
  `isCommandSupportedOnDevice` ladder has no exhaustiveness — a new platform with no matrix entry is a *future
  hazard* (it returns `false`/falls through, not a compile error). *(Note: the survey's first pass called this a
  "silent web mis-gate"; on closer reading at `capabilities.ts:298` it returns `false` — the real defect is the
  closed key-set with no exhaustiveness, which is cheaper to fix but still wrong.)*
- `RecordingProvider` is literally named `startIosSimulatorRecording`.
- **macOS is a hidden sub-platform**: ~697 LOC of macOS lives inside `platforms/ios/`, while `platforms/macos/`
  is a 19-LOC stub; the Apple interactor lives in `core/interactors/apple.ts` and reaches into `platforms/ios`.

### Supporting debt (the duplication the missing abstractions *force*)

| Debt | Evidence | Est. LOC |
|---|---|---|
| `client-types.ts` hand-mirrors every Options/Result | 1027 LOC, 83 interfaces, imports 25 modules to re-declare contracts | ~550 derivable |
| Every result is `Promise<Record<string,unknown> \| void>` | `DaemonResponseData`, all Interactor methods, `runAppleRunnerCommand` | the weakest seam |
| `core/dispatch*` leaks platform knowledge | ~16 dynamic `import('../platforms/*')` + ~15 branches | ~120 |
| Two platform contracts glued by string round-trip | `Interactor` vs `AgentDeviceBackend`, ~30 ops each | ~130 |
| Batch-step validation reimplemented at 5 layers | `metadata.ts`/`projection.ts` byte-for-byte parallel | ~150 |
| `RecordingBackend` not generic → 5 `as Extract` casts | `record-trace-recording-backends.ts:54,130,179,211,230` | ~12 |
| ~8k LOC client/remote unfoldered at src root | 55 files; `daemon-` prefix co-locates client + server + proxy | move |
| `utils/` hosts 3 subsystems + domain types | CLI parser 3k, screenshot-diff 1.8k, AX-snapshot, `device.ts` | move |
| Daemon 'generic' family disowned; boilerplate | chain returns `null` for 'generic'; 22 guards; 13 literals; recordAction ×24 | ~190 |
| MCP dead `jsonRpcRequestSchema`; force-cast at HTTP edge | `contracts.ts:541` unused; `http-server.ts:390` | ~70 |

### Legacy to drop — real but *small* (do at next major)

- Legacy batch step shape `{command,positionals,flags}` in `cli/batch-steps.ts` (~110 LOC, already gated to next major)
- Deprecated `--maestro`/`replayMaestro` alias (~20), `--session-locked`/`--session-lock-conflicts` aliases (~25)
- `src/batch.ts` test-only re-export barrel (~19)
- **`compat/maestro` (5.5k LOC) is NOT legacy** — it is the `.ad` replay engine, invoked on *every* replay
  action. **Keep it; wrap it as a fixed contract; never change the wire shape under it.**
- Dead exports ≈ 0 (fallow default mode: 1 known false positive). The 232 "prod-unused" exports are LIVE test
  seams — **not** a shrink opportunity.

> The big reduction is **not** from deleting legacy (~175 LOC). It is from collapsing the duplication that the
> two missing abstractions force.

---

## 3. The perfect shape — target architecture

```
                         ┌──────── INTERFACES (thin adapters) ────────┐
                         cli/        mcp/        sdk/        (batch is a command, not a layer)
                         └───────────────────┬────────────────────────┘
                                             │  derive tools/schema/help
                  ┌──────────────────────────▼──────────────────────────┐
                  │   COMMAND REGISTRY  (one CommandDescriptor per cmd)   │  ◄── the spine
                  │   name · inputSchema · typed Result · capability ·    │
                  │   daemon{route,traits} · surfaces · invoke · execute  │
                  └───┬───────────────┬───────────────┬──────────────┬────┘
            derives ▼      derives ▼        derives ▼       derives ▼
        capability matrix   daemon registry   batch allowlist   dispatch (TOTAL map)
                                             │
                                             ▼  execute(ctx, input): CommandResult<Name>
                  ┌──────────────────────────▼──────────────────────────┐
                  │   PLATFORM REGISTRY  (one PlatformPlugin per family)  │  ◄── second seam
                  │   createInteractor · capability bucket · discover ·   │
                  │   providers · recording · appLog · perf   (LAZY)      │
                  └───┬─────────────┬──────────────┬─────────────┬────────┘
                  apple(ios+macos)  android        linux         web
                    │ wraps XCTest    │ wraps adb     │ ...          │ ...   ← irreducible leaf code, UNCHANGED
                    ▼
        ┌──────────────────────── kernel/ (dependency sink) ────────────────────────┐
        │  device.ts · contracts.ts · errors.ts · command-result.ts · capabilities  │
        │              pure domain types + pure logic — no IO, no platform           │
        └───────────────────────────────────────────────────────────────────────────┘

  Folder DAG (imports point DOWN; siblings never import siblings):
    kernel ◄ platforms ◄ core ◄ commands ◄ {cli, client, daemon/server}
    client ◄ daemon/client     remote,metro ◄ daemon/client     sdk = re-export barrels only
```

The shape is **two registries over a clean DAG with a typed spine**:

1. **`CommandDescriptor` registry** — the single source for a command's identity. The ~10 tables become *pure
   derivations*. Dispatch becomes a total map keyed by the command-name union (missing handler = compile error).
2. **`PlatformPlugin` registry** — the single source for a platform's behavior. `getInteractor`, capabilities,
   discovery, providers, recording, app-log, perf all become `getPlugin(device.platform).x()`. The three
   allow-lists derive from `registry.keys()`. Plugins load **lazily** (dynamic import inside the factory) so CLI
   cold-start latency — a north-star metric — never regresses.
3. **Typed-result spine** — `CommandResult<Name>` replaces `Record<string,unknown>`; `client-types.ts` Options
   derive from `inputSchema`, Results from `CommandResult`. Generic `RecordingBackend<P>` deletes the 5 casts.
4. **Clean layering** — a `kernel/` sink owns domain types; the src-root cluster and the utils-buried
   subsystems move into intent folders behind an import-direction lint.
5. **Agent-cost as thin grafts, not a subsystem** — leveled payloads (`digest|default|full` where `default` ==
   today's wire shape), per-command MCP `outputSchema` from `CommandResult`, batch as the primary multi-step
   primitive (intermediate steps elide to digest), and capability-derived typed errors (`{code, retriable,
   supportedOn}`) so an agent self-corrects without a wasted round-trip.

---

## 4. Why this shape is perfect — measured against the north star

| North-star goal | How the shape delivers | Honest caveat |
|---|---|---|
| **Add a platform cheaply** | One plugin file + one registration line; the union line in `device.ts`. Wiring drops ~90 files → ~3. Half-wired platform = compile error. | The *interactor* (XCUITest/adb-equivalent) is irreducible — thousands of LOC. "Cheap" = the wiring, not the driver. |
| **Add a command cheaply** | One descriptor file; the ~10 tables derive. ~24 files → ~2. | A genuinely new *platform primitive* still needs the per-platform impl + (for iOS) the Swift runner verb. |
| **Fast + cheap for AI agents** | Leveled/digest payloads cut snapshot/screenshot tokens; batch collapses N round-trips → 1; typed errors with `supportedOn` kill retry round-trips; per-command MCP `outputSchema` lets agents trust `structuredContent` over re-parsing text; zero-load fast-paths answer `tools/list`/`--help`/`devices` without spinning the platform graph. | Must be **opt-in** with `default` == today's wire shape, or the Maestro `.ad` recompare path breaks. |
| **Less code** | Delete `client-types.ts` mirror (~550), batch dup (~150), dispatch/registry/capability literals (~250), bag-guards (~120). | Net ~**-1k to -3k LOC**. Don't oversell; capability rows and daemon traits *relocate*, they don't vanish. |
| **Scoped ownership** | `kernel/` sink + intent folders + import-direction lint; the 'generic' daemon family re-owned; deep modules replace shallow re-export layers. | The folder reorg is high-*diff*, low-*LOC*; sell it as ownership + lint, not shrink. |
| **Type safety** | Command-name union (exhaustive dispatch), per-command `CommandResult`, generic `RecordingBackend<P>`, parse-at-boundary at the JSON-RPC/HTTP edge. | ~40 result shapes are legitimately heterogeneous — don't block the registry on theoretically-pure Result types day one. |

**Why it's *perfect* and not just *better*:** the two axes of this product's entire future — *more platforms*
and *more commands* — become the two things you extend by adding **one file each**, while everything that is
genuinely hard (device-specific gesture synthesis, the replay engine) stays isolated behind a contract and is
never touched by a wiring change. The codebase's shape finally matches its growth vectors.

---

## 5. Prototypes (concrete, grounded in real signatures)

> Full code sketches are distilled below; each is buildable against the current types.

### 5.1 `PlatformPlugin` (the platform axis)

```ts
// src/platforms/plugin.ts — type-only imports + LAZY impls (mirrors today's `await import('../platforms/*')`)
export type PlatformPlugin = {
  readonly id: string;                               // also the capability-matrix bucket key
  readonly platforms: readonly Platform[];           // Apple owns BOTH ['ios','macos'] ← folds in the macOS unwind
  readonly familySelector?: PlatformSelector;        // 'apple' → ios+macos
  createInteractor(device: DeviceInfo, runner: RunnerContext): Promise<Interactor>;   // replaces getInteractor switch arm
  discoverDevices(req: DeviceInventoryRequest): Promise<DeviceInfo[]>;                  // replaces inventory if-chain
  readonly capability: { bucket: 'apple'|'android'|'linux'|'web';
                         supportsByDefault?(d: DeviceInfo, m: KindMatrix): boolean };  // sub-platform guards live here
  readonly providers?: () => Partial<PlatformProviderResolvers>;
  readonly recording?: { start(req: PlatformRecordingRequest): RecordingProcess };     // de-iOS-named
  readonly appLog?: { start(req): Promise<AppLogResult>; logBackend(d): LogBackend };
  readonly perf?: { collect(d: DeviceInfo): Promise<Record<string, unknown>> };
};

const registry = new Map<Platform, PlatformPlugin>();
export function getPlugin(p: Platform): PlatformPlugin {
  const x = registry.get(p);
  if (!x) throw new AppError('UNSUPPORTED_PLATFORM', `Unsupported platform: ${p}`);
  return x;
}
export const registeredPlatforms = () => [...registry.keys()];   // ← the 3 allow-lists derive from this

// register-builtins.ts asserts exhaustiveness vs the hand-authored union:
//   Object.fromEntries(registeredPlatforms().map(p => [p, true])) satisfies Record<Platform, true>;
//   → a new Platform literal without a plugin is a COMPILE error.

// Derived call-sites:
const getInteractor = (d, r) => getPlugin(d.platform).createInteractor(d, r);
function isCommandSupportedOnDevice(cmd, device) {
  const cap = COMMAND_CAPABILITY_MATRIX[cmd];               if (!cap) return true;
  const plugin = tryGetPlugin(device.platform);            if (!plugin) return false;   // ← no more fallthrough
  const m = cap[plugin.capability.bucket];                 if (!m) return false;
  if (cap.supports && !cap.supports(device)) return false;
  return m[device.kind ?? 'unknown'] === true;
}
```

**Honest limitation:** the *compile-time* `Platform` union must stay hand-authored (you can't derive a TS type
from a runtime `Map`). The registry is asserted exhaustive against it, and the three *runtime* lists collapse —
but "add a platform" still touches the `device.ts` union line.

**Apple is the first real plugin — and owns an `AppleOS` leaf axis.** The Apple plugin owns `apple` (today's
`ios`+`macos`) and discriminates `ios | ipados | tvos | watchos | visionos | macos` via an `appleOs` field —
**not** six `Platform` literals (which would collide with the cross-platform `target` axis). The XCTest runner
already builds `ios|macos|tvos` and ~85% of `platforms/ios` is already the OS-agnostic Apple engine, so this is
mostly relocate-and-rename for iOS/iPadOS/tvOS/macOS; visionOS is scoped net-new work and watchOS is an
explicit unsupported sentinel (XCUITest can't drive it). ADR 0009 owns the AppleOS decision; remaining
implementation state is tracked in the [Phase 3 tracking issue #972](https://github.com/callstack/agent-device/issues/972).

### 5.2 `CommandDescriptor` (the command axis) — *facet composition*, honoring ADR 0003

One registration **composes facets whose type + ownership stay in their domain module** — this is "compose
with [ADR 0003](../docs/adr/0003-daemon-command-registry.md)", not "collapse daemon policy into a public
registry."

```ts
// src/commands/<family>/press.ts — the single registration site (kills cross-table drift)
export const press = defineCommand({
  surface:    pressSurface,       // owned by src/commands/**       (identity, cliReader, schema, mcp)
  capability: pressCapability,    // owned by src/core/capabilities
  daemon:     pressDaemon,        // owned by src/daemon/   ← ADR 0003 ownership PRESERVED
  result:     {} as PressResult,  // typed CommandResult
});

// src/daemon/command-policy/press.ts — DAEMON-owned facet (lives UNDER src/daemon/, not commands/)
export const pressDaemon = defineDaemonFacet('press', {
  route: 'interaction', replayScopedAction: true, androidBlockingDialogGuard: true,
  // allowSessionlessDefaultDevice / skipSessionlessProviderDevice closures stay here, verbatim
});

// Projections BUILD each consumer's table; they never restate identity:
const DAEMON_REGISTRY   = buildDaemonRegistry(commands.map(c => c.daemon));   // built under src/daemon/
const CAPABILITY_MATRIX = Object.fromEntries(commands.map(c => [c.name, c.capability]));
const BATCH_ALLOWLIST   = commands.filter(c => c.surface.batchable).map(c => c.name);
const DISPATCH: { [N in Command]: Execute<N> } = /* total map: a missing handler is a compile error */;
// getDaemonCommandRoute / isLeaseAdmissionExempt / shouldLockSessionExecution … UNCHANGED for callers.
```

**The four invariants (from the [ADR 0003 amendment](../docs/adr/0003-daemon-command-registry.md)) the design
must satisfy:**
1. Daemon traits **owned under `src/daemon/`**, composed in — never inlined as fields on the public contract.
2. **Predicate interface unchanged** — derivation changes how the table is *built*, not how it is *read*.
3. **No leakage** — public projections (catalog/CLI/MCP/help/capability) are type-prevented from reading
   daemon-only traits, and vice versa.
4. **One declaration per concern, enforced by types** — a missing/duplicate facet is a *compile error*
   (replacing today's "aligned by convention").

### 5.3 Typed-result spine

```ts
export interface CommandResultMap {                 // tighten per command; default keeps the union total
  snapshot: SnapshotResult; screenshot: ScreenshotResult;
  press: PressCommandResult;                          // ← already exists in contracts/interaction.ts
}
export type CommandResult<N extends string> = N extends keyof CommandResultMap ? CommandResultMap[N] : Record<string, unknown>;

// generic RecordingBackend deletes all 5 `as Extract` casts; a missing backend is a compile error:
export type RecordingBackend<P extends RecordingPlatform = RecordingPlatform> = {
  stop: (ctx: RecordingStopContext<RecordingFor<P>>) => Promise<DaemonResponse | null>;   // PRE-NARROWED
  /* ...start/resolveOutputPath... */
};
const recordingBackends = { ios: …, android: …, 'ios-device-runner': …, 'macos-runner': …, web: … }
  satisfies { [P in RecordingPlatform]: RecordingBackend<P> };
```

### 5.4 Agent-cost grafts (ride on 5.2 + 5.3 — *not* a new subsystem)

```ts
export type ResponseLevel = 'digest' | 'default' | 'full';   // 'default' == today's wire shape (protects Maestro)
const snapshotView: ResponseView<SnapshotResult> = { toView(r, lvl) {
  if (lvl === 'full') return r;
  if (lvl === 'default') return stripRects(r);                // byte-for-byte today
  return { nodeCount: r.nodes.length, refs: r.nodes.filter(n => n.hittable).slice(0, 12).map(n => n.ref) };
}};
export type TypedError = { code: ErrorCode; message: string; hint?: string;
                           retriable?: boolean; supportedOn?: string };  // supportedOn DERIVED from descriptor.capability

// Phase-0 parse-at-boundary (independent, ships first): wire the DEAD jsonRpcRequestSchema into the MCP/HTTP edge,
// killing `parsed as JsonRpcMessage[]` (server.ts:133) and `params as unknown as Partial<DaemonRequest>` (http-server.ts:390).
```

### 5.5 Target folder DAG (pure `ts-morph .move()` codemods, leaf-first)

```
src/
  kernel/         device.ts (←utils, 92 importers) · contracts.ts · errors.ts · command-result.ts · capabilities.ts
  client/         client*.ts · companion/
  daemon/client/  daemon-client*.ts          daemon/server/  daemon-runtime.ts · bootstrap
  remote/         daemon-proxy · daemon-artifacts · upload-client · remote-*
  metro/          metro* · client-metro*
  sdk/            re-export barrels only (package.json `exports` ← rewrite in the SAME commit, verify with `npm pack`)
  cli/parser/     ← absorb utils/{args,cli-flags,cli-help} (~2.5k)
  screenshot-diff/  ← utils (1.8k, 1 consumer)        snapshot/  ← utils AX-snapshot domain
  core/ commands/ platforms/ recording/ replay/ compat/ mcp/ contracts/   (KEEP)

Rule (lint-enforced): imports point DOWN toward kernel; siblings never import siblings;
                      only daemon/server may import platforms/ statically.
```

---

## 6. How to get there — the roadmap (strangler-fig, leverage-per-risk)

**Discipline:** every step is independently shippable *and* revertable; each derived table is asserted
**byte-for-byte equivalent** to the hand table by a parity test **before** the hand table is deleted. The moment
a step can't ship alone, the plan has failed.

| Phase | Step | Risk | Payoff |
|---|---|---|---|
| **0 · confidence builders** (behaviorless) | **(b) ✅ shipped** — exhaustive capability platform selection; **(c) ✅ shipped** — generic `RecordingBackend<P>` (5 casts deleted); (a) parse-at-boundary on MCP/HTTP edge; (d) collapse the 3 platform allow-lists + 5-layer batch validation | low | correctness/security; builds muscle memory; touches no identity table |
| **1 · command spine** | (a) **invert the import graph** — `commandRegistry` becomes root, `command-catalog`/`capabilities`/`daemon-registry`/`batch-policy` derive (parity-tested, no deletion yet); (b) promote each family's facet → `CommandDescriptor` additively; (c) replace the 24-arm switch with the total map, arm-by-arm | **med** (the import-cycle inversion is the real first-week blocker: `command-catalog` has ~95 importers and the facet imports `AgentDeviceClient` today) | finishes a proven seam; add-command → ~2 files; enables everything below |
| **2 · typed results** (the parity oracle) | (a) `CommandResultMap` with `Record` default, migrate per-command from real runner payloads; (b) graft `TypedError`; fold the disowned 'generic' family into `handlers/` **last**; (c) kill the `client-types.ts` mirror (~550 LOC) | med (must be per-command, never a big-bang retype of 203 files) | the safety net the platform unwind needs; biggest single LOC win |
| **3 · platform plugin** (now safe) | (a) define `PlatformPlugin`, **lazy** factories (cold-start benchmark guards latency); (b) move capability columns onto plugin grants, **porting every `supports()` closure verbatim**, pinned by the table-equivalence test before deletion; (c) ✅ unwind macOS and the OS-agnostic Apple engine out of `platforms/ios`; (d) finish Apple plugin facets, tvOS leaf, final `Platform` collapse, and watchOS sentinel last. The **Apple plugin is the first instance** and owns the `AppleOS` leaves — see ADR 0009 and the [Phase 3 tracking issue #972](https://github.com/callstack/agent-device/issues/972) | **high** (touches shared platform routing and the XCTest runner) | add-platform wiring → ~3 files; kills the 231-branch smear |
| **4 · agent-cost** (opt-in) | (a) `ResponseView.toView` with `default`==today; `responseLevel` knob defaulting to `default`; (b) typed `BatchStepResult` → intermediate steps digest; per-command MCP `outputSchema`; generalize zero-load fast-paths | med (wire-shape risk vs Maestro — strictly opt-in) | the north-star-#2 token/latency wins |
| **5 · layering + legacy** (quiet windows) | intent-folder moves + utils extraction as pure path codemods; at next major drop the ~175 LOC of legacy aliases/barrels | low-per-step, high-diff | scoped ownership + import lint; merge-pain risk → land fast, small |

**Dependency logic:** command-first (proven seam, lowest blast radius) → typed results (the oracle) → platform
plugin (bigger prize, riskier, *needs* the oracle) → agent-cost (rides on both) → layering/legacy (orthogonal,
noisy, last).

---

## 7. What NOT to touch (the dissent, preserved)

- **The Maestro `.ad` replay engine** (`compat/maestro`, 5.5k LOC) — load-bearing; wrap as a fixed contract,
  never rewrite, and never let leveled payloads change the wire shape its recompare path assumes.
- **The iOS XCTest synthesis** (`RunnerSynthesizedGesture`, two-finger synthesis) and **adb/idb leaf code** —
  genuinely toolchain-specific, correctly isolated, the site of hard-won flakiness fixes. The plugin contract's
  job is to stop core/daemon *branching* on platform, **not** to homogenize these irreducible leaves.
- **The `supports()` / `unsupportedHint()` device closures** — they encode macOS-coordinate-pinch, tvOS-no-touch,
  physical-iOS, and two-finger-synthesis nuance. **Relocate them onto descriptors/plugins verbatim; never flatten
  them to data** that loses the device-shaped logic.
- **The dynamic-import lazy-loading** that keeps CLI cold-start low — preserve as factory laziness.
- **The two process seams** (`invoke` cross-process vs `execute` in-daemon) — share *types* across the boundary;
  do **not** collapse the two interfaces and endanger remote/cloud/tunnel/proxy transport.
- **By-design behaviors** from repo conventions — ambiguous-device rejection, the iOS get-text fast-path, "batch
  is stop-only." A "uniform typed result" pass must not flatten these.

**Highest-regret mistakes to avoid:** a big-bang typed-result retype; unifying `Interactor`+`AgentDeviceBackend`
*and* splitting macOS out of iOS in the same PR; deleting any capability table before a parity test pins the new
grants; bundling the folder reorg with the registry work (maximizes diff-noise against parallel-session commits).

---

## 8. Before / after — the command axis

(The platform-axis decision lives in ADR 0009; current implementation status lives in
the [Phase 3 tracking issue #972](https://github.com/callstack/agent-device/issues/972).)

```
BEFORE — a command's identity is RESTATED in ~10 hand-synced tables, aligned "by convention"
─────────────────────────────────────────────────────────────────────────────────────────────

   command "press" = a bare string shared by every table below (no compile-time link between them)

   PUBLIC surface              DAEMON-INTERNAL              DERIVED-BY-HAND
   ─────────────────           ──────────────────           ──────────────────
   • command-catalog.ts        • daemon-command-            • client-types.ts (Options/Result
     (public identity)           registry.ts                  mirror, ~550 LOC)
   • commands/** contracts       route + policy traits      • core/dispatch.ts (24-arm switch,
     (cliReader / daemonWriter)  ✔ ADR 0003: own file,         default: throw)
   • capabilities.ts             internal-only,             • client.ts wrappers
     (apple/android matrix)      predicate interface        • batch-policy.ts allowlist
                                 (isLeaseAdmissionExempt,
                                  shouldLockSessionExec…)
                                        ▲
                                        └── consumed by 8 daemon request modules

   ⇒ add/rename a command = touch ~10 files; a missed table compiles fine and fails at RUNTIME (drift)
   ✔ ADR 0003 already isolated daemon policy correctly — the problem is everything ELSE is also separate
```

```
AFTER — ONE registration composes DOMAIN-OWNED facets; the ~10 tables become DERIVED projections
─────────────────────────────────────────────────────────────────────────────────────────────────────

   src/commands/<family>/press.ts
   defineCommand({                          each facet's TYPE + OWNERSHIP stays in its domain module
      surface:    … ,  ─────────────────►   src/commands/**        (identity, cli, schema, mcp)
      capability: … ,  ─────────────────►   src/core/capabilities
      daemon:     … ,  ─────────────────►   src/daemon/    ◄── ADR 0003 ownership PRESERVED
      result:     … ,  ─────────────────►   typed CommandResult
   })
   single registration site · a missing/duplicate facet = COMPILE ERROR (drift killed structurally)
            │
            ▼  pure projections — they BUILD each table, they don't restate it
   ┌──────────────────────────────────────────────────────────────────────────────────────────┐
   │  catalog · capability matrix · batch allowlist · dispatch map · client types               │ ← PUBLIC views
   │  daemon-command-registry ── still exposes the SAME predicates; the 8 callers are UNCHANGED  │ ← daemon view
   └──────────────────────────────────────────────────────────────────────────────────────────┘

   ADR 0003 invariants held:
     (1) daemon traits OWNED under src/daemon/, never inlined into the public command surface
     (2) predicate interface unchanged — derivation changes how the table is BUILT, not how it is READ
     (3) public projections type-prevented from reading daemon-only traits (no leakage)
     (4) one declaration per concern, enforced by the type system (was "aligned by convention")
```

**The two axes are the same thesis** — replace *"identity smeared across many tables/branches"* with *"one
registration → everything else derives or looks up"*:

```
   PLATFORM axis                                  COMMAND axis
   ─────────────                                  ─────────────
   PlatformPlugin registry (§5.1)                 CommandDescriptor registry (§5.2)
     └─ Apple plugin ──owns──► appleOs              └─ defineCommand(...) ──derives──► catalog,
        { ios … macos … visionos }                    capability, daemon-registry, batch, dispatch,
   (ADR 0009 / phase3 progress)                       client-types   (daemonFacet honors ADR 0003)
```

---

## 9. The one-line version

> Give the two things this product grows by — **platforms** and **commands** — each *one file you extend*, make
> every other table *derive* from those two, type the results so the derivations are sound, and never touch the
> irreducible leaf code. Command-first, because its typed-result seam is the safety net the platform unwind needs.
