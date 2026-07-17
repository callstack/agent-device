# ADR 0015: Direct Maestro Compatibility Engine

## Status

Accepted

## Context

At decision time, Maestro YAML compiled into generic `SessionAction` strings. Commands whose semantics did not
match native replay become private `__maestro*` names with positional payloads, then replay dispatch
routes those strings through a second Maestro switch before recursively invoking ordinary daemon
commands. Compatibility state is split between the replay variable scope and three `WeakMap` caches.

That path grew a second selector resolver, several polling loops, action-after-assertion recovery, and
gesture-coordinate adapters. The indirection makes successful responses hard to prove: a fast native
wait may establish text existence while the compatibility assertion requires a visible Maestro target.
It also hides authored coordinate space until runtime positional decoding.

The inbound implementation was about 5,000 production lines and 5,000 focused test lines.
Android compatibility is materially faster than native Maestro in the pager and navigation suites;
that advantage is a product constraint, not expendable migration headroom.

ADR 0013 separately owns public gesture normalization, contact topology, trajectory planning, and
native injection. Maestro's supported gesture surface is single-pointer swipe only. Maestro swipes
normalize to ADR 0013's canonical `pan` input (origin, delta, durationMs) and carry the
`endpoint-hold` execution profile through a daemon-internal compatibility seam
(`internal.gestureExecutionProfile`), preserving iOS fast-swipe-then-hold behavior without exposing
the profile on the public command surface.

## Decision

Parse supported Maestro YAML into a source-preserving typed program and execute it directly through a
narrow compatibility runtime port. Do not lower the program through `SessionAction`, private command
names, positional JSON, or a recursive replay dispatcher. The daemon adapter may invoke ordinary public
commands as typed operations; those calls reuse the shared command semantics and never re-enter Maestro
parsing or compatibility dispatch.

The engine has five responsibilities:

1. The parser validates the supported grammar and preserves source path and line on every command.
2. The interpreter owns hooks, includes, environment scopes, conditions, repeat/retry, and ordered
   command execution. Runtime repeat/retry blocks remain compact plan nodes; the plan does not expand
   authored iteration counts. `repeat.times` preserves the authored count, while retry clamps
   `maxRetries` to upstream's three-retry preset (four total attempts).
3. The runtime port exposes typed app, input, observation, target, and single-pointer gesture
   operations backed by the existing agent-device runtime and platform adapters.
4. One explicit execution context owns variables and the current observation generation. A mutation
   invalidates that generation; reads may reuse semantic evidence only within the same generation.
   Geometry is action-local and is never carried across command boundaries.
5. An observer adapts source-aware progress, traces, artifacts, and failures to the existing replay and
   test result contracts. Observer telemetry is redacted and best-effort; trace persistence cannot
   change command success or failure.

Maestro `stopApp` terminates its target through a daemon-internal app-only close and preserves the
owning replay session. Public `close` remains the session finalizer that releases recordings, runner
state, leases, and stored runtime hints.

The engine does not implement platform input. Absolute and percentage swipes preserve authored
endpoints without a hierarchy capture. Directional horizontal swipes reuse ADR 0013's shared in-page
preset geometry so an iOS right swipe does not become an interactive-back gesture; vertical presets
retain Maestro's platform geometry. All viewport-relative swipes resolve the cheapest fresh interaction
viewport available so ADR 0013 can validate every planned sample. Maestro swipes pair that resolved
viewport with `internal.gestureExecutionProfile: 'endpoint-hold'` on the nested public `gesture` request
so ADR 0013 produces the iOS fast-swipe-then-hold profile without a public `executionProfile` field.
When normalization already resolves a viewport, the adapter pairs it with the nested public gesture
request as daemon-internal metadata. ADR 0013 planning consumes that exact frame instead of probing
the platform a second time.

Target-relative swipes reuse the target-resolution observation. The resulting typed single-pointer
motion enters ADR 0013 as the canonical `pan` input, with the `endpoint-hold` execution profile carried
as daemon-internal metadata. Maestro code cannot construct or execute two-pointer pan, pinch, rotate,
transform, or physical pointer trajectories.

Simple successful target queries return their match, visibility decision, candidate count, and
observation generation in one response. The daemon may retain the provider snapshot behind that
evidence, but geometry stays action-local. Raw hierarchies, screenshots, and complete candidate lists
are failure/debug artifacts, not happy-path requirements.

The daemon adapter may retain the provider snapshot behind a successful observation without exposing it
through the engine contract. A following target resolution may use that snapshot only as semantic
evidence. Maestro selector semantics use the shared structurally normalized provider snapshot, before
iOS canonical interactive presentation. They deliberately do not request the public `snapshot --raw`
shape, whose output contract bypasses shared pruning and overlay annotations. On iOS, the adapter derives the provider's canonical
interactive presentation from that same snapshot without another capture. Raw matching still selects
the node and authored index; when that same source node has canonical interactive bounds, tap-like
actions use those bounds. A unique exact, canonically hittable match may be dispatched with its
resolved point so XCTest binds the live selector identity and coordinate delivery atomically; a
structured live-selector miss, ambiguity, point mismatch, or off-screen result
falls back to fresh Maestro resolution. All other targets capture fresh geometry before coordinate
dispatch. Maestro visibility does not apply agent-device's React Native overlay blocking policy;
debug-overlay handling remains an explicit public-command workflow. Visibility can
be true while a scroll view or tab strip is still moving, so an observation frame is never authoritative
for a later interaction, even within the same mutation generation. Every mutating attempt invalidates
retained evidence before dispatch, including an attempt whose dispatch reports failure, because the
adapter cannot prove the app stayed unchanged.

Maestro target resolution preserves upstream first-match and explicit-index semantics. Equivalent iOS
accessibility wrapper chains are normalized to the semantic control or deepest matching leaf before
applying an authored index, matching XCTest element-query behavior without changing distinct nested
matches. It does not adopt the public agent-device command surface's unique-match requirement. Conversely, an
`AMBIGUOUS_MATCH` produced by a nested public command is an agent-device authoring failure and is not
suppressed by Maestro `optional`; atomic iOS dispatch handles that result by performing fresh Maestro
resolution, as described above. Cancellation and infrastructure failures are likewise non-optional.

Mutations that can leave an in-flight transition record a pending stabilization boundary. Before another
mutating command, the runtime samples at the compatibility polling cadence until the hierarchy is stable
and retains that final observation for the next read. Commands with specialized completion semantics settle
inline instead. Hierarchy signatures project the available semantic attributes, tree topology, and
fixed-order integer edges while excluding provider-only metadata, object-key order, and subpixel noise.

An authored observation after a mutation skips the pending barrier and polls its own condition immediately.
Its successful snapshot becomes the baseline for the boundary but does not discharge mutation ordering. If
another mutation follows, the runtime waits one polling interval and compares a fresh hierarchy with that
baseline, continuing until stable when the UI is still changing. If no later mutation follows, it performs no
extra capture. This intentionally differs from upstream Maestro, which settles before evaluating an assertion,
and retains the previous agent-device compatibility engine's faster read behavior without allowing a later
tap, gesture, scroll, or input to overtake an in-flight transition.

`retryTapIfNoChange` defaults to false. When explicitly enabled, the runtime compares the stable hierarchy
with the target-resolution hierarchy. On iOS, an unchanged hierarchy triggers the same screenshot comparison
used by Maestro; the runtime retries once only when both surfaces remain unchanged. Screenshot evidence is
best-effort because a failed capture cannot prove that repeating a mutation is safe. The stable hierarchy
primes the next command, so the retry policy does not add another hierarchy read there.

`waitForAnimationToEnd` uses its own screenshot-stability operation, matching upstream's two immediate
captures per attempt and 0.005% normalized absolute RGB-difference threshold. These captures explicitly
bypass ordinary screenshot stabilization so the command observes the application rather than
recursively waiting on another settling policy. Screenshot stability does not discharge a pending
mutation boundary; a later mutating command still verifies hierarchy stability before dispatch. On iOS,
comparison captures use the persistent runner's screenshot surface so both frames come from one warmed
transport and avoid simulator screenshot setup between polls.

Upstream Maestro is a version-pinned development reference, not a production dependency. Conformance is
enforced by the three-layer oracle in `scripts/maestro-conformance` (issue #1274), which replaced the
original hand-typed parser fixture. Layer 1 drives the pinned `maestro-orchestra` YAML parser
(`dev.mobile:maestro-orchestra:2.5.1`, SHA-verified at regeneration) over a corpus of vendored upstream
flows plus targeted bug-class flows, capturing each parse; the deterministic verifier replays that
capture against our engine and classifies every flow as identical / both-reject / we-reject / mismatch,
requiring each non-identical outcome to be a declared, on-the-record divergence. Layer 2 reads upstream
constants (retry cap, animation-wait threshold/timeout, erase cap) and parser-observed defaults (swipe
duration) straight from the pinned bytecode and cross-checks each against the live `MAESTRO_COMPATIBILITY_PRESETS`
constant. Both generated layers are checked in and verified in CI via `node --test` with no Java. Because
per-PR CI cannot re-derive them, each fixture carries a `contentHash` seal that the verifier recomputes,
so a hand edit to a captured command or constant fails the build; the scheduled `conformance-regenerate`
job then re-runs the harness against the pinned jars and fails on any byte difference, which is what makes
"generated from upstream" enforced rather than documented. Layer 3 runs a small set of app-observable
differential scenarios (settle ordering, tap retries, optional warned-vs-failed) through both engines
against the real fixture app, pinning the Maestro CLI to the same version as layers 1-2; it is scheduled,
never per-PR. Layer 3 carries the same declared-divergence contract as layer 1: a scenario that currently
fails declares a `knownDivergence` with a required tracking issue, the schedule stays green on that known
gap, and only undeclared divergences fail. A declaration that stops reproducing also fails, so the fix PR
must remove it and the differential becomes the acceptance test for its own findings. This exists because
the instrument must not be blocked on repairing what it just measured. The four #1217 regressions (percent
rounding/rejection, target-swipe direction default, retry-cap semantics, settle-loop ordering) each have a
dedicated fixture. Percent truncation's runtime half is pinned by a pure unit test rather than a device
scenario, because a one-pixel delta is not app-observable. Bug class 4's detector is an engine-side timing
invariant, unit-tested against synthetic traces, that executes on the device path — currently blocked by a
declared `scrollUntilVisible` divergence (#1299) that the differential itself found on its first working run.

Documented intentional deviations are encoded as expected-divergence entries rather than silent
mismatches: the hierarchy-vs-screenshot animation wait (constants match, mechanism differs), the
horizontal-swipe in-page presets, condition-poll-as-stabilization, ambiguity strictness under `optional`,
and the omitted iOS 3s pre-tap static gate (`IOSDriver.SCREEN_SETTLE_TIMEOUT_MS`, a layer-2 reference-only
vector).

## Performance Contract

The migration cannot switch production routing until Android and iOS satisfy all of these on the pager
and react-navigation corpora:

- total wall time is no slower than the pre-migration compatibility engine;
- an observation immediately after a mutation polls its authored condition directly; a later mutation uses
  that result as its stabilization baseline;
- no command captures a second hierarchy merely to re-verify evidence produced within that command;
- absolute coordinate swipes perform one direct viewport query and no accessibility capture;
- mutation-to-mutation stabilization is deferred to the next command boundary and primes the following read;
- percentage swipe conversion preserves authored endpoints exactly;
- helper/runner startup remains amortized across a suite;
- p50/p95 command latency, hierarchy and screenshot captures, tap retries, and transferred hierarchy
  bytes are reported separately;
- failure-only diagnostics are excluded from happy-path latency comparisons.

Android verification must prove the bundled helper backend and version. iOS verification must separate
runner startup from warm command latency. Both platforms rerun the non-Maestro gesture canaries; their
two-pointer plans, executor selection, and app-observable effects must remain unchanged.

## Migration

Completed. Production Maestro YAML now uses the typed program, immutable replay plan, and direct
runtime port exclusively. The `SessionAction` lowering path, private `__maestro*` commands,
`replayControl`, hidden compatibility caches, positional decoders, and their fallback routing were
deleted in the same change. Generic `.ad` replay remains independent.

1. Add the typed program, runtime port, direct interpreter, and normalized upstream fixtures without
   changing production routing.
2. Differentially compare the old lowering path and direct engine at the typed operation boundary.
3. Move lifecycle, input, screenshot, and keyboard commands.
4. Move target queries and assertions, deleting unverified fast-path success and assertion-triggered
   action replay.
5. Move single-pointer swipes through ADR 0013's normalized input boundary.
6. Move hooks, includes, conditions, repeat/retry, and trusted `runScript`.
7. Switch `--maestro` atomically, then delete private Maestro commands, positional decoding, hidden
   caches, and obsolete converter/runtime tests.

The old and new engines may coexist only in tests during migration. Shipping two production engines or
a runtime fallback between them is rejected because it doubles semantic and performance ownership.

## Consequences

- Maestro remains a supported subset with explicit failures; this refactor does not expand parity.
- Source provenance and runtime values stay typed through execution.
- Compatibility policy remains local while device behavior stays in shared runtimes and backends.
- Cross-platform correctness may require richer provider query evidence, but not additional round trips.
- ADR 0013 can be rewritten internally without changing Maestro as long as its normalized
  single-pointer boundary and executor guarantees remain available.

## Alternatives Considered

- Embed upstream Orchestra: rejected because Java startup, package weight, driver ownership, and
  platform coverage would erase performance and backend advantages.
- Build a shared replay VM first: rejected until native `.ad` needs structured runtime control flow;
  one caller does not justify a broader abstraction.
- Keep compiling to typed `SessionAction` variants: rejected because it retains the replay trampoline
  and prevents the compatibility engine from owning observation generations directly.
