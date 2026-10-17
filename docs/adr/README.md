# ADR index — read this when…

| ADR | Read when you touch… |
| --- | --- |
| [0001 Provider-First Integration Scenarios](0001-provider-first-integration-scenarios.md) | integration testing strategy, provider transcripts, the scenario harness |
| [0002 Persistent Platform Helper Sessions](0002-persistent-platform-helper-sessions.md) | helper process lifecycle, keep-alive semantics |
| [0003 Daemon Command Registry](0003-daemon-command-registry.md) | daemon routing, request-policy traits |
| [0004 iOS Snapshot Backend Strategy](0004-ios-snapshot-backend-strategy.md) | snapshot capture plans, backend fallbacks, quality verdicts, the coordinate space a capture publishes |
| [0005 iOS Runner Interaction Lifecycle](0005-ios-runner-interaction-lifecycle.md) | XCTest runner sessions, leases, adoption, idle-stop |
| [0006 Daemon RPC Protocol Version](0006-daemon-rpc-protocol-version.md) | remote daemon HTTP/JSON-RPC compatibility |
| [0007 Remote Device Leases](0007-remote-device-leases.md) | leases, tenancy, provider-owned devices |
| [0008 Command Descriptor Registry](0008-command-descriptor-registry.md) | command additions or changes, any surface projection (CLI/MCP/client/batch), timeout policy |
| [0009 Apple Platform Consolidation](0009-apple-platform-consolidation.md) | Apple platform family, apple/appleOs axes, the apple-leak guard |
| [0010 Error system conventions](0010-error-system.md) | error codes, hints, normalizeError, typed error signals |
| [0011 Interaction Guarantee Contract](0011-interaction-guarantee-contract.md) | interaction dispatch paths, fast paths, guards, the guarantee matrix, parity tables |
| [0012 Interactive Replay](0012-interactive-replay.md) | replay healing/`--update`, diagnostic resolution disclosure, bounded `.ad` target-binding evidence, bounded divergence wire/error handling, plan-bound replay-only `--from` semantics, and agent-supervised re-record repair ("heal-by-doing") |
| [0013 Unified Gesture Plans](0013-unified-gesture-plans.md) | gesture API/routing, contact topology, multi-touch geometry, native pointer injection, two-finger pan |
| [0014 Session Ref-Frame Lifetime](0014-session-ref-frame-lifetime.md) | ref authorization epochs, complete/partial issuance, pre-side-effect expiration, replay/batch compatibility, and cross-platform stale-mutation policy |
| [0015 Direct Maestro Compatibility Engine](0015-direct-maestro-engine.md) | Maestro YAML parsing/execution, compatibility observation policy, conformance, performance gates, gesture integration |
| [0016 Active-Session Script Publication](0016-active-session-script-publication.md) | publication of an armed open-to-destination `.ad` script that retains its live session |
| [0017 Parameterized Recorded Inputs](0017-parameterized-recorded-inputs.md) | safe authoring of sensitive fill inputs as `${VAR}` placeholders across recording, replay, and repair |
| [0018 Unified Request Event Journal (Proposed)](0018-unified-event-journal.md) | event/diagnostic vocabulary, journal scopes and sinks, progress-channel separation, observability-only state |
| [0019 Request-Bound Platform Runtime](0019-request-bound-platform-runtime.md) | platform-package boundaries/composition, device discovery, runtime facts/facets, request binding, provider ownership, platform-shaped session resources, durable reattachment, daemon-handler migration |
| [0020 Composable Recorded Fragments (Proposed)](0020-composable-recorded-fragments.md) | lifecycle-free recorded fragment capture/composition, entry guards, fragment-local addresses/digests, staleness, and native `.ad`/Maestro composition |
| [0021 Simlock-Leased Devices Through Ordinary Local Runtimes](0021-host-simlock-managed-device-allocation.md) | operation of a Simlock-leased simulator or emulator, the reason for no agent-device allocator integration, and the withdrawn in-process Host design |
| [0022 Daemon — Platform Runtime Coupling Audit and Ownership Ratchets](0022-daemon-platform-runtime-coupling.md) | daemon imports of root `platform-runtime-*` modules, the coupling ban that replaces R76 edge classification, the R75 session-authority ratchet, entry-to-platform hop routes and roles |
| [0023 End-State Entry-to-Platform Hop Trace](0023-end-state-hop-trace.md) | the definition of hop counts, ordered `press`/Android and dual-arm `snapshot`/iOS chains, per-hop roles, and the deletion test for numbers in ADR 0019 and ADR 0022 |
| [0024 Screen Recording — One Coordinator, Two Facts (Proposed)](0024-screen-recording-provable-signal.md) | `record start`/`stop` lifecycle, separate export-exists / recorder-stopped facts, backend stop-and-collect contract, coordinator recovery, the ADR 0019 §5 amendment, and the failed-finish cleanup fix |
| [0025 Foldable Apple Panels — Capture the Lit Panel](0025-foldable-apple-panels.md) | iPhone Duo outer/inner panels, CoreDevice display info as sole screen authority, black-panel capture from `simctl`'s implicit display default, derived (never asserted) pose, `fold` pose control, and the Android emulator posture amendment |
| [0026 Scroll Clip Authority — Ownership Is the Parent Edge](0026-scroll-clip-authority.md) | iOS scroll indicators and the visible band, parent-edge ownership instead of ancestor traversal, permitted node removal from interactive snapshots, and ejection dispositions |
| [0027 Descriptor Root Size vs Eager-Closure Budget](0027-descriptor-root-vs-eager-closure-budget.md) | accepted: the eager-closure budget permits only a statement-neutral hub split (containment + added-module novelty + flat top-level-statement weight); `packages/command-registry/src/registry.ts` may be split |
| [0028 Capability-Family Cell Vocabulary — One Runtime Source (Proposed)](0028-capability-family-cell-vocabulary.md) | capability operation family additions, `UnavailablePlatformRuntimeFacts` / `UNAVAILABLE_CELLS`, `INTERACTOR_OPERATIONS`, and the reason for repeated changes across eight packages |
| [0029 Daemon Policy](0029-daemon-policy.md) | `AGENT_DEVICE_DAEMON_POLICY`, limits on daemon commands, devices, or device shutdown, and where operator rules are enforced for batch/replay steps |
| [0030 Process Lock Exclusion](0030-process-lock-exclusion.md) | process-lock publication/reclaim/release, retained mutation guards, and the single-protocol upgrade boundary |
| [0031 macOS Native App Backend](0031-macos-native-app-backend.md) | `AGENT_DEVICE_MACOS_APP_BACKEND`, macOS app sessions without XCTest Automation Mode, the accessibility-only pointer action rule, and the ghost cursor |
| [0032 Layering Graph Engine](0032-layering-graph-engine.md) | replacement evaluation for `scripts/layering/` graph rules with dependency-cruiser or fallow `boundaries`, the reason that graph-based layering checks share one replaceable import model, the measured edge-set and parity gaps, and the revisit triggers |
| [0033 Collocation decision table](0033-collocation-decision-table.md) | moves or additions for files in umbrella #3276 §5, renewed proposals for a move that the table refused, and a zone's collocation decisions |
| [0034 Provider plugin registry](0034-provider-plugin-registry.md) | provider plugins, the `agent-device/plugins` contract, plugin sources and order, duplicate provider ids, plugin failure isolation, the daemon plugin inventory and `daemon status` |

ADRs record rationale.
The registries and gates they describe are the current source of truth.
If prose and a registry disagree, the registry takes precedence.
The ADR then needs a follow-up.

Use these shape conventions to keep ADRs inexpensive to consult:

- **Put normative rules first.** Put Status before a terse "Rules at a glance" summary.
  The summary lets readers stop there.
  Put full contracts and rationale below it.
- **Retain rationale and rejected alternatives.** They prevent repeated discussion of settled decisions.
  Put them below the summary.
- **Process history is deleted once complete.** Keep completed migration plans, per-step implementation tables, and point-in-time status logs only in git history.
  In Status, keep one line that states this deletion.
  In Status, also keep any accepted waiver or evidence gap that is still relevant.
- If a gate enforces a rule, retain its rationale and a gate pointer instead of repeated rule details.
