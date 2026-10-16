# ADR 0015: Direct Maestro Compatibility Engine

## Status

Accepted

## Rules at a glance

- Parse supported Maestro YAML into a source-preserving typed program. Execute it directly through a narrow compatibility runtime port.
- Do not lower the program through `SessionAction`, private command names, positional JSON, or a recursive replay dispatcher.
- One explicit execution context owns variables and the current observation generation.
- Every mutating attempt invalidates retained evidence before dispatch, including an attempt whose dispatch reports failure.
- Keep geometry action-local. Never carry it across command boundaries.
- Preserve upstream first-match and explicit-index semantics. Do not adopt the unique-match requirement of the public command surface.
- Maestro `optional` does not suppress an `AMBIGUOUS_MATCH` from a nested public command.
- Before another mutating command, settle the pending stabilization boundary. Commands with specialized completion semantics settle inline instead.
- An authored observation after a mutation skips the pending barrier and polls its own condition immediately.
- Preserve the performance contract. Encode documented intentional deviations as declared expected-divergence entries.
- Keep `${...}` interpolation variable-lookup-only. Gate `evalScript` with `MaestroEngineOptions.trustedScripts`.
- Do not ship two production engines or a runtime fallback between them.

## Context

At decision time, Maestro YAML compiled into generic `SessionAction` strings.
Commands whose semantics did not match native replay became private `__maestro*` names with positional payloads.
Replay dispatch then routed those strings through a second Maestro switch before it recursively invoked ordinary daemon commands.
Compatibility state was split between the replay variable scope and three `WeakMap` caches.

That path grew a second selector resolver, several polling loops, action-after-assertion recovery, and gesture-coordinate adapters.
The indirection makes successful responses hard to prove.
For example, a fast native wait may establish text existence while the compatibility assertion requires a visible Maestro target.
The indirection also hides authored coordinate space until runtime positional decoding.

The inbound implementation was approximately 5,000 production lines and 5,000 focused test lines.
Android compatibility is materially faster than native Maestro in the pager and navigation suites.
That advantage is a product constraint, not expendable migration headroom.

ADR 0013 separately owns public gesture normalization, contact topology, trajectory planning, and native injection.
Maestro's supported gesture surface is single-pointer swipe only.
Maestro swipes normalize to ADR 0013's canonical `pan` input (origin, delta, durationMs).
They carry the `endpoint-hold` execution profile through a daemon-internal compatibility seam (`internal.gestureExecutionProfile`).
This preserves iOS fast-swipe-then-hold behavior, and the public command surface does not expose the profile.

## Decision

Parse supported Maestro YAML into a source-preserving typed program.
Execute the program directly through a narrow compatibility runtime port.
Do not lower the program through `SessionAction`, private command names, positional JSON, or a recursive replay dispatcher.
The daemon adapter may invoke ordinary public commands as typed operations.
Those calls reuse the shared command semantics and never re-enter Maestro parsing or compatibility dispatch.

The engine has five responsibilities:

1. The parser validates the supported grammar and preserves source path and line on every command.
2. The interpreter owns hooks, includes, environment scopes, conditions, repeat/retry, and ordered command execution.
   Runtime repeat/retry blocks remain compact plan nodes.
   The plan does not expand authored iteration counts.
   `repeat.times` preserves the authored count.
   Retry clamps `maxRetries` to upstream's three-retry preset (four total attempts).
3. The runtime port exposes typed app, input, observation, target, and single-pointer gesture operations.
   The existing agent-device runtime and platform adapters back these operations.
4. One explicit execution context owns variables and the current observation generation.
   A mutation invalidates that generation.
   Reads may reuse semantic evidence only within the same generation.
   Geometry is action-local and is never carried across command boundaries.
5. An observer adapts source-aware progress, traces, artifacts, and failures to the existing replay and test result contracts.
   Observer telemetry is redacted and best-effort.
   Trace persistence cannot change command success or failure.

Maestro `stopApp` terminates its target through a daemon-internal app-only close and preserves the owning replay session.
Public `close` remains the session finalizer that releases recordings, runner state, leases, and stored runtime hints.

The engine does not implement platform input.
Absolute and percentage swipes preserve authored endpoints without a hierarchy capture.
Directional horizontal swipes reuse ADR 0013's shared in-page preset geometry.
Thus, an iOS right swipe does not become an interactive-back gesture.
Vertical presets retain Maestro's platform geometry.
All viewport-relative swipes resolve the least expensive fresh interaction viewport available, so that ADR 0013 can validate every planned sample.
Maestro swipes pair that resolved viewport with `internal.gestureExecutionProfile: 'endpoint-hold'` on the nested public `gesture` request.
Thus, ADR 0013 produces the iOS fast-swipe-then-hold profile without a public `executionProfile` field.
If normalization already resolves a viewport, the adapter pairs it with the nested public gesture request as daemon-internal metadata.
ADR 0013 planning consumes that exact frame and does not probe the platform a second time.

Target-relative swipes reuse the target-resolution observation.
The resulting typed single-pointer motion enters ADR 0013 as the canonical `pan` input.
The `endpoint-hold` execution profile is carried as daemon-internal metadata.
Maestro code cannot construct or execute two-pointer pan, pinch, rotate, transform, or physical pointer trajectories.

Simple successful target queries return their match, visibility decision, candidate count, and observation generation in one response.
The daemon may retain the provider snapshot behind that evidence, but geometry stays action-local.
Raw hierarchies, screenshots, and complete candidate lists are failure/debug artifacts, not happy-path requirements.

The daemon adapter may retain the provider snapshot behind a successful observation without exposing it through the engine contract.
A following target resolution may use that snapshot only as semantic evidence.
Maestro selector semantics use the shared structurally normalized provider snapshot, before iOS canonical interactive presentation.
They deliberately do not request the public `snapshot --raw` shape, whose output contract bypasses shared pruning and overlay annotations.
On iOS, the adapter derives the provider's canonical interactive presentation from that same snapshot without another capture.
Raw matching still selects the node and authored index.
If that same source node has canonical interactive bounds, tap-like actions use those bounds.
A unique exact, canonically hittable match may be dispatched with its resolved point.
XCTest then binds the live selector identity and coordinate delivery atomically.
A structured live-selector miss, ambiguity, point mismatch, or off-screen result falls back to fresh Maestro resolution.
All other targets capture fresh geometry before coordinate dispatch.
Maestro visibility does not apply agent-device's React Native overlay blocking policy.
Debug-overlay handling remains an explicit public-command workflow.
Visibility can be true while a scroll view or tab strip is still in motion.
Thus, an observation frame is never authoritative for a later interaction, even within the same mutation generation.
Every mutating attempt invalidates retained evidence before dispatch.
This includes an attempt whose dispatch reports failure, because the adapter cannot prove that the app stayed unchanged.

Maestro target resolution preserves upstream first-match and explicit-index semantics.
Before an authored index applies, equivalent iOS accessibility wrapper chains are normalized to the semantic control or the deepest matching leaf.
This matches XCTest element-query behavior and does not change distinct nested matches.
Maestro target resolution does not adopt the unique-match requirement of the public agent-device command surface.
Conversely, an `AMBIGUOUS_MATCH` from a nested public command is an agent-device authoring failure.
Maestro `optional` does not suppress it.
Atomic iOS dispatch handles that result with fresh Maestro resolution, as described above.
Cancellation and infrastructure failures are likewise non-optional.

Mutations that can leave an in-flight transition record a pending stabilization boundary.
Before another mutating command, the runtime samples at the compatibility polling cadence until the hierarchy is stable.
The runtime retains that final observation for the next read.
Commands with specialized completion semantics settle inline instead.
Hierarchy signatures project the available semantic attributes, tree topology, and fixed-order integer edges.
They exclude provider-only metadata, object-key order, and subpixel noise.

An authored observation after a mutation skips the pending barrier and polls its own condition immediately.
Its successful snapshot becomes the baseline for the boundary but does not discharge mutation ordering.
If another mutation follows, the runtime waits one polling interval and compares a fresh hierarchy with that baseline.
If the UI is still changing, the runtime continues until the hierarchy is stable.
If no later mutation follows, the runtime performs no extra capture.
This intentionally differs from upstream Maestro, which settles before it evaluates an assertion.
It retains the faster read behavior of the previous agent-device compatibility engine.
It does not allow a later tap, gesture, scroll, or input to overtake an in-flight transition.

`retryTapIfNoChange` defaults to false.
If it is explicitly enabled, the runtime compares the stable hierarchy with the target-resolution hierarchy.
On iOS, an unchanged hierarchy triggers the same screenshot comparison that Maestro uses.
The runtime retries once, and only if both surfaces remain unchanged.
Screenshot evidence is best-effort because a failed capture cannot prove that the repetition of a mutation is safe.
The stable hierarchy primes the next command, so the retry policy does not add another hierarchy read there.

`waitForAnimationToEnd` uses its own screenshot-stability operation.
It matches upstream's two immediate captures per attempt and the 0.005% normalized absolute RGB-difference threshold.
These captures explicitly bypass ordinary screenshot stabilization.
Thus, the command observes the application and does not recursively wait on another settling policy.
After a successful authored visual wait, screenshot stability discharges the same-generation pending mutation boundary.
No hierarchy capture precedes the visual barrier.
If the visual deadline arrives before a stable pair is observed, that boundary stays pending for the hierarchy settle of the next mutating command.
On iOS, comparison captures use the screenshot surface of the persistent runner.
Thus, both frames come from one warmed transport, and no simulator screenshot setup occurs between polls.

Upstream Maestro is a version-pinned development reference, not a production dependency.
Conformance is enforced by the three-layer oracle in `scripts/maestro-conformance` (issue #1274).
That oracle replaced the original hand-typed parser fixture.

1. Layer 1 drives the pinned `maestro-orchestra` YAML parser (`dev.mobile:maestro-orchestra:2.5.1`) over a corpus.
   The corpus contains vendored upstream flows plus targeted bug-class flows.
   The pinned parser is SHA-verified at regeneration.
   Layer 1 captures each parse.
   The deterministic verifier replays that capture against our engine.
   The verifier classifies every flow as identical / both-reject / we-reject / mismatch.
   Each non-identical outcome must be a declared, on-the-record divergence.
2. Layer 2 reads upstream constants (retry cap, animation-wait threshold/timeout, erase cap) straight from the pinned bytecode.
   It also reads parser-observed defaults (swipe duration) straight from the pinned bytecode.
   It cross-checks each value against the live `MAESTRO_COMPATIBILITY_PRESETS` constant.
3. Layer 3 runs a small set of app-observable differential scenarios through both engines against the real fixture app.
   The scenarios cover settle ordering, tap retries, and optional warned-vs-failed.
   Layer 3 pins the Maestro CLI to the same version as layers 1-2.
   It is scheduled, never per-PR.

Both generated layers are checked in and verified in CI via `node --test` with no Java.
Per-PR CI cannot re-derive them.
Each fixture therefore carries a `contentHash` seal that the verifier recomputes.
Thus, a hand edit to a captured command or constant fails the build.
The scheduled `conformance-regenerate` job then re-runs the harness against the pinned jars and fails on any byte difference.
That job makes "generated from upstream" enforced rather than documented.

Layer 3 carries the same declared-divergence contract as layer 1.
A scenario that currently fails declares a `knownDivergence` with a required tracking issue.
The schedule stays green on that known gap, and only undeclared divergences fail.
A declaration that stops reproducing also fails.
Thus, the fix PR must remove the declaration, and the differential becomes the acceptance test for its own findings.
This contract exists because the instrument must not be blocked on the repair of what it just measured.

Each of the four #1217 regressions has a dedicated fixture:

- Percent rounding/rejection.
- Target-swipe direction default.
- Retry-cap semantics.
- Settle-loop ordering.

A pure unit test, rather than a device scenario, pins the runtime half of percent truncation, because a one-pixel delta is not app-observable.
The detector for bug class 4 is an engine-side timing invariant that executes on the device path.
Unit tests exercise that detector against synthetic traces.
On the device path, the detector is currently blocked by a declared `scrollUntilVisible` divergence (#1299).
The differential itself found that divergence on its first working run.

Documented intentional deviations are encoded as expected-divergence entries rather than silent mismatches:

- The hierarchy-vs-screenshot animation wait (the constants match, but the mechanism differs).
- The horizontal-swipe in-page presets.
- Condition-poll-as-stabilization.
- Ambiguity strictness under `optional`.
- The omitted iOS 3s pre-tap static gate (`IOSDriver.SCREEN_SETTLE_TIMEOUT_MS`, a layer-2 reference-only vector).

## Performance Contract

The direct engine preserves these properties on Android and iOS across the pager and react-navigation corpora:

- Total wall time is no slower than the pre-migration compatibility engine.
- An observation immediately after a mutation polls its authored condition directly.
  A later mutation uses that result as its stabilization baseline.
- No command captures a second hierarchy only to re-verify evidence produced within that command.
- Absolute coordinate swipes perform one direct viewport query and no accessibility capture.
- Mutation-to-mutation stabilization is deferred to the next command boundary and primes the following read.
- Percentage swipe conversion preserves authored endpoints exactly.
- Helper/runner startup remains amortized across a suite.
- p50/p95 command latency, hierarchy and screenshot captures, tap retries, and transferred hierarchy bytes are reported separately.
- Failure-only diagnostics are excluded from happy-path latency comparisons.

Android verification must prove the bundled helper backend and version.
iOS verification must separate runner startup from warm command latency.
Both platforms rerun the non-Maestro gesture canaries.
Their two-pointer plans, executor selection, and app-observable effects must remain unchanged.

## Consequences

- agent-device supports selected Maestro Flow syntax and behavior.
  Unsupported features return explicit errors.
  Intentional differences are declared in the conformance fixtures.
- By decision (#1292), `${...}` interpolation stays variable-lookup-only.
  Upstream's GraalJS expression evaluation is not reimplemented outside `evalScript`.
  Thus, unresolved or expression-shaped payloads fail loudly with source context.
  The escape hatches are `evalScript` (inline expression → `output.*` leaves) and `runScript` (file compute) → `${output.x}` (consume).
  `evalScript` is the one command whose payload is evaluated as JavaScript.
  Flow env and prior `output` leaves are bound as strings in a `node:vm` context.
  The assigned `output` object folds back into the flat string-key model.
  Thus, `${output.uppercaseName}` and `${output.list.length}` resolve.
  `assertTrue` (#1295) is scoped to that same lookup-only subset.
  That subset is literal values and bare `${VAR}` lookups, evaluated with a pinned string-truthiness table.
  `node:vm` is explicitly not a security sandbox.
  A bound context's prototype chain still resolves to host `Object`/`Function`, so an untrusted expression can escape it.
  `runScript` already carried this trust assumption for daemon-local flows.
  `evalScript` inherits the same assumption.
  However, `evalScript` is reachable from a flow accepted over the daemon's remote HTTP surface.
  Thus, `MaestroEngineOptions.trustedScripts` gates `evalScript`.
  The HTTP boundary (`restrictRemoteHttpRequest`) sets that option from `publicNetworkOnly`.
  If the option is false, `evalScript` is refused outright.
- Shipping two production engines or a runtime fallback between them is rejected because it doubles semantic and performance ownership.
- Source provenance and runtime values stay typed through execution.
- Compatibility policy remains local, while device behavior stays in shared runtimes and backends.
- Cross-platform correctness may require richer provider query evidence, but not additional round trips.
- ADR 0013 can be rewritten internally without a change to Maestro, as long as its normalized single-pointer boundary and executor guarantees remain available.

## Alternatives Considered

- **Embed upstream Orchestra.** Rejected because Java startup, package weight, driver ownership, and platform coverage would erase performance and backend advantages.
- **Build a shared replay VM first.** Rejected until native `.ad` needs structured runtime control flow.
  One caller does not justify a broader abstraction.
- **Keep compiling to typed `SessionAction` variants.** Rejected because it retains the replay trampoline and prevents the compatibility engine from owning observation generations directly.
