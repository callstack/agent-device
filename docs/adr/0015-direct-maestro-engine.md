# ADR 0015: Direct Maestro Compatibility Engine

## Status

Accepted

## Rules at a glance

- Parse supported YAML into a source-preserving typed Maestro program. Execute it through a narrow compatibility runtime port.
- Do not route Maestro programs through `SessionAction`, private command names, positional JSON, or recursive replay dispatch.
- Keep variables and observation generation in one execution context. Every mutation attempt invalidates retained evidence before dispatch.
- Keep geometry action-local. Do not reuse it across command boundaries.
- Preserve upstream first-match/index semantics and the stated public-command ambiguity exception.
- Defer pending stabilization to the next mutation. Authored observations poll their own conditions immediately.
- Preserve the performance contract and declare conformance divergences.
- Keep `${...}` interpolation lookup-only. Gate `evalScript` through `MaestroEngineOptions.trustedScripts`.
- Do not ship two production engines or a runtime fallback between them.

## Context

At decision time, Maestro YAML compiled to generic `SessionAction` strings.
Commands incompatible with native replay became private `__maestro*` names with positional payloads.
Replay dispatch routed those strings through a second Maestro switch, then recursively invoked ordinary daemon commands.
Replay variable scope and three `WeakMap` caches divided compatibility state.

This path acquired a second selector resolver, several polling loops, action-after-assertion recovery, and gesture-coordinate adapters.
The indirection makes successful responses hard to prove.
For example, a fast native wait can prove text existence while compatibility requires a visible Maestro target.
Positional decode also hides authored coordinate space until runtime.

The incoming implementation had approximately 5,000 production lines and 5,000 focused test lines.
Android compatibility is materially faster than native Maestro in pager and navigation suites.
This advantage is a product constraint, not spare migration capacity.

ADR 0013 owns public gesture normalization, contact topology, trajectory plans, and native injection.
Maestro supports only single-pointer swipe gestures.
These normalize to canonical `pan` with origin, delta, and durationMs.
Daemon-internal `internal.gestureExecutionProfile` carries `endpoint-hold`.
This preserves iOS fast-swipe-then-hold behavior without a public execution-profile option.

## Decision

Parse supported Maestro YAML into a source-preserving typed program.
Execute it directly through a narrow compatibility runtime port.
Do not lower it through `SessionAction`, private command names, positional JSON, or recursive replay dispatch.
The daemon adapter may invoke ordinary public commands as typed operations.
Those calls reuse shared command semantics without re-entry into Maestro parsing or compatibility dispatch.

The engine has five responsibilities:

1. The parser validates supported grammar and preserves source path and line on every command.
2. The interpreter owns hooks, includes, environment scopes, conditions, repeat/retry, and ordered execution.
   Runtime repeat/retry blocks remain compact plan nodes without expansion of authored iteration counts.
   `repeat.times` preserves the authored count.
   Retry clamps `maxRetries` to upstream's three-retry preset, for four total attempts.
3. The runtime port exposes typed app, input, observation, target, and single-pointer gesture operations.
   Existing agent-device runtimes and platform adapters execute them.
4. One explicit execution context owns variables and current observation generation.
   Mutation invalidates that generation.
   Reads may reuse semantic evidence only within the same generation.
   Geometry stays action-local and never crosses command boundaries.
5. An observer adapts source-aware progress, traces, artifacts, and failures to existing replay/test results.
   Observer telemetry is redacted and best-effort.
   Trace persistence cannot change command success or failure.

Maestro `stopApp` uses a daemon-internal app-only close and preserves the owning replay session.
Public `close` remains the session finalizer for recordings, runner state, leases, and stored runtime hints.

The engine does not implement platform input.
Absolute and percentage swipes preserve authored endpoints without hierarchy capture.
Directional horizontal swipes reuse ADR 0013's shared in-page preset geometry.
Thus, an iOS right swipe does not become an interactive-back gesture.
Vertical presets retain Maestro's platform geometry.
Every viewport-relative swipe resolves the least expensive fresh interaction viewport available.
ADR 0013 then validates every planned sample.
The nested public `gesture` request pairs that viewport with `internal.gestureExecutionProfile: 'endpoint-hold'`.
This produces iOS fast-swipe-then-hold behavior without public `executionProfile`.
If normalization already resolved a viewport, the adapter supplies that exact frame as daemon-internal metadata.
ADR 0013 consumes it without another platform probe.

Target-relative swipes reuse the target-resolution observation.
Their typed single-pointer motion enters ADR 0013 as canonical `pan` with internal `endpoint-hold` metadata.
Maestro code cannot construct or execute two-pointer pan, pinch, rotate, transform, or physical pointer trajectories.

Simple successful target queries return match, visibility decision, candidate count, and observation generation in one response.
The daemon may retain the provider snapshot behind the evidence.
Geometry remains action-local.
Raw hierarchies, screenshots, and full candidate lists are failure/debug artifacts, not successful-path requirements.

The daemon adapter may retain a successful observation's provider snapshot without exposing it through the engine contract.
A following target resolution may use it only as semantic evidence.
Maestro selectors use the shared structurally normalized provider snapshot before canonical iOS interactive presentation.
They intentionally do not request public `snapshot --raw`, which bypasses shared pruning and overlay annotations.
On iOS, the adapter derives canonical interactive presentation from the same snapshot without another capture.
Raw matching selects the node and authored index.
If the same source node has canonical interactive bounds, tap-like actions use them.

A unique exact canonically hittable match may dispatch with its resolved point.
XCTest then binds live selector identity and coordinate delivery atomically.
A structured live-selector miss, ambiguity, point mismatch, or offscreen result returns to fresh Maestro resolution.
All other targets capture fresh geometry before coordinate dispatch.
Maestro visibility does not apply agent-device's React Native overlay blocking policy.
Debug-overlay handling remains an explicit public-command workflow.
A scroll view or tab strip can remain in motion while visibility is true.
Thus, an observation frame never authorizes a later interaction, even within one mutation generation.
Before dispatch, every mutation attempt invalidates retained evidence.
This includes failed dispatch because the adapter cannot prove that the app remained unchanged.

Maestro resolution preserves upstream first-match and explicit-index semantics.
Before authored index selection, equivalent iOS accessibility wrapper chains normalize to the semantic control or deepest matching leaf.
This matches XCTest element queries without changing distinct nested matches.
It does not adopt public agent-device unique-match requirements.
Conversely, nested public-command `AMBIGUOUS_MATCH` is an agent-device authoring failure.
Maestro `optional` does not suppress it.
Atomic iOS dispatch handles it through fresh Maestro resolution, as above.
Cancellation and infrastructure failures are also non-optional.

Mutations that can leave transitions in flight record a pending stabilization boundary.
Before another mutation, the runtime samples at compatibility polling cadence until the hierarchy stabilizes.
It retains the final observation for the next read.
Commands with specialized completion semantics settle inline instead.
Hierarchy signatures project available semantic attributes, topology, and fixed-order integer edges.
They exclude provider-only metadata, object-key order, and subpixel noise.

An authored observation after mutation skips the pending barrier and immediately polls its own condition.
Its successful snapshot becomes the boundary's baseline without discharging mutation order.
If another mutation follows, the runtime waits one polling interval and compares a fresh hierarchy with that baseline.
If the UI still changes, it continues until stable.
If no later mutation follows, it performs no extra capture.
Upstream Maestro instead settles before assertion evaluation.
This intentional difference retains the previous engine's faster reads while preventing later tap, gesture, scroll, or input from overtaking transitions.

`retryTapIfNoChange` defaults to false.
If explicitly enabled, the runtime compares stable hierarchy with target-resolution hierarchy.
On iOS, unchanged hierarchy triggers Maestro's screenshot comparison.
It retries once only if both surfaces remain unchanged.
Screenshot evidence is best-effort because failed capture cannot prove safe mutation repetition.
The stable hierarchy prepares the next command without another hierarchy read.

`waitForAnimationToEnd` owns a screenshot-stability operation.
It matches upstream's two immediate captures per attempt and 0.005% normalized absolute RGB-difference threshold.
These captures bypass ordinary screenshot stabilization to avoid a recursive wait on another stabilization policy.
After successful authored visual wait, screenshot stability discharges the same-generation pending mutation boundary.
No hierarchy capture precedes that visual barrier.
If no stable pair appears before the visual deadline, the boundary remains pending for the next mutation's hierarchy stabilization.
On iOS, comparison captures use the persistent runner's screenshot surface.
Both frames therefore use one initialized transport without simulator screenshot setup between polls.

Upstream Maestro is a version-pinned development reference, not a production dependency.
`scripts/maestro-conformance` enforces a three-layer oracle (issue #1274) instead of a manually typed parser fixture:

1. Layer 1 runs pinned `maestro-orchestra` YAML parser `dev.mobile:maestro-orchestra:2.5.1` over vendored upstream flows and targeted failure-class flows.
   Regeneration verifies its SHA.
   The harness captures each parse.
   A deterministic verifier replays captures against this engine.
   Every flow becomes identical / both-reject / we-reject / mismatch.
   Every non-identical outcome requires an explicit declared divergence.
2. Layer 2 reads upstream retry cap, animation-wait threshold/timeout, and erase cap directly from pinned bytecode.
   It also reads parser-observed swipe-duration defaults.
   It compares each value with live `MAESTRO_COMPATIBILITY_PRESETS`.
3. Layer 3 runs app-observable differential scenarios through both engines on the real fixture app.
   These include stabilization order, tap retries, and optional warned-vs-failed outcomes.
   It pins Maestro CLI to the same version as layers 1–2.
   It runs on a schedule, never per PR.

Both generated layers are committed and verified in CI through `node --test` without Java.
Per-PR CI cannot regenerate them.
Each fixture therefore carries a `contentHash` seal recomputed by the verifier.
Manual changes to captured commands or constants fail the build.
Scheduled `conformance-regenerate` reruns the harness against pinned jars and fails on any byte difference.
Thus, checks enforce upstream generation.

Layer 3 uses the same declared-divergence contract as Layer 1.
A failing scenario declares `knownDivergence` with a required tracking issue.
Known gaps keep the schedule green; only undeclared divergences fail.
A declaration that no longer reproduces also fails.
Thus, a fix PR must remove it, and the differential becomes its acceptance test.
The measurement instrument must remain usable before its detected defects are repaired.

Each of the four #1217 regressions has a dedicated fixture:

- Percent rounding/rejection.
- Target-swipe direction default.
- Retry-cap semantics.
- Stabilization-loop order.

A pure unit test fixes percent truncation's runtime behavior because a one-pixel delta is not app-observable.
Failure class 4 uses an engine-side timing invariant on the device path, unit-tested with synthetic traces.
A declared `scrollUntilVisible` divergence (#1299) currently blocks it.
The differential itself detected that gap on its first working run.

Expected-divergence entries encode intentional deviations:

- Hierarchy-vs-screenshot animation wait, with matching constants but different mechanisms.
- Horizontal-swipe in-page presets.
- Condition polls used for stabilization.
- Ambiguity strictness under `optional`.
- Omitted iOS 3s pre-tap static gate, `IOSDriver.SCREEN_SETTLE_TIMEOUT_MS`, retained as a layer-2 reference-only vector.

## Performance Contract

Across Android/iOS pager and react-navigation corpora, the direct engine preserves:

- Total wall time no slower than the pre-migration compatibility engine.
- Immediate authored condition polls after mutation, with that result as a later mutation's stabilization baseline.
- No second hierarchy capture solely to verify evidence produced within the same command.
- One direct viewport query and no accessibility capture for absolute coordinate swipes.
- Deferred mutation-to-mutation stabilization at the next command boundary, with its result reused by the following read.
- Exact authored endpoints after percentage swipe conversion.
- Helper/runner startup amortized across a suite.
- Separate reports for p50/p95 command latency, hierarchy/screenshot captures, tap retries, and transferred hierarchy bytes.
- Failure-only diagnostics excluded from successful-path latency comparisons.

Android verification must prove the bundled helper backend and version.
iOS verification must separate runner startup from warm command latency.
Both platforms rerun non-Maestro gesture canaries.
Their two-pointer plans, executor selection, and app-observable effects must remain unchanged.

## Consequences

- agent-device supports selected Maestro Flow syntax and behavior.
  Unsupported features return explicit errors.
  Conformance fixtures declare intentional differences.
- By decision #1292, `${...}` interpolation remains variable-lookup-only.
  Upstream GraalJS expression evaluation is not duplicated outside `evalScript`.
  Unresolved or expression-shaped payloads fail explicitly with source context.
  Available computation paths are:
  - `evalScript`: inline expression → `output.*` leaves.
  - `runScript`: file computation → `${output.x}` consumption.
  Only `evalScript` evaluates its payload as JavaScript.
  Flow env and prior `output` leaves bind as strings in a `node:vm` context.
  Assigned `output` becomes the flat string-key model.
  Thus, `${output.uppercaseName}` and `${output.list.length}` resolve.
  `assertTrue` (#1295) uses the same lookup-only subset: literal values and bare `${VAR}` lookups with a fixed string-truthiness table.
  `node:vm` is explicitly not a security sandbox.
  A bound context's prototype chain still reaches host `Object`/`Function`, so untrusted expressions can escape it.
  Daemon-local `runScript` already has this trust assumption.
  `evalScript` inherits it but is also reachable through remote HTTP flows.
  `MaestroEngineOptions.trustedScripts` therefore gates it.
  HTTP boundary `restrictRemoteHttpRequest` sets this option from `publicNetworkOnly`.
  If false, `evalScript` is refused outright.
- Two production engines or runtime fallback between them are rejected because they duplicate semantic and performance ownership.
- Source provenance and runtime values remain typed through execution.
- Compatibility policy stays local; shared runtimes/backends retain device behavior.
- Cross-platform correctness may require richer provider query evidence, but not additional round trips.
- ADR 0013 internals can change while its normalized single-pointer boundary and executor guarantees remain available to Maestro.

## Alternatives Considered

- **Embed upstream Orchestra.** Rejected because Java startup, package weight, driver ownership, and platform coverage would remove performance and backend advantages.
- **Build a shared replay VM first.** Rejected until native `.ad` needs structured runtime control flow.
  One caller does not justify a broader abstraction.
- **Continue compilation to typed `SessionAction` variants.** Rejected because it retains recursive replay dispatch and prevents direct ownership of observation generations.
