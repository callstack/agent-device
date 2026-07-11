# ADR index — read this when…

| ADR | Read when you touch… |
| --- | --- |
| [0001 Provider-First Integration Scenarios](0001-provider-first-integration-scenarios.md) | integration testing strategy, provider transcripts, the scenario harness |
| [0002 Persistent Platform Helper Sessions](0002-persistent-platform-helper-sessions.md) | helper process lifecycle, keep-alive semantics |
| [0003 Daemon Command Registry](0003-daemon-command-registry.md) | daemon routing, request-policy traits |
| [0004 iOS Snapshot Backend Strategy](0004-ios-snapshot-backend-strategy.md) | snapshot capture plans, backend fallbacks, quality verdicts |
| [0005 iOS Runner Interaction Lifecycle](0005-ios-runner-interaction-lifecycle.md) | XCTest runner sessions, leases, adoption, idle-stop |
| [0006 Daemon RPC Protocol Version](0006-daemon-rpc-protocol-version.md) | remote daemon HTTP/JSON-RPC compatibility |
| [0007 Remote Device Leases](0007-remote-device-leases.md) | leases, tenancy, provider-owned devices |
| [0008 Command Descriptor Registry](0008-command-descriptor-registry.md) | adding/changing a command, any surface projection (CLI/MCP/client/batch), timeout policy |
| [0009 Apple Platform Consolidation](0009-apple-platform-consolidation.md) | Apple platform family, apple/appleOs axes, the apple-leak guard |
| [0010 Error system conventions](0010-error-system.md) | error codes, hints, normalizeError, typed error signals |
| [0011 Interaction Guarantee Contract](0011-interaction-guarantee-contract.md) | interaction dispatch paths, fast paths, guards, the guarantee matrix, parity tables |
| [0012 Interactive Replay](0012-interactive-replay.md) | replay healing/`--update`, diagnostic resolution disclosure, bounded `.ad` target-binding evidence, bounded divergence wire/error handling, plan-bound replay-only `--from` semantics, and agent-supervised re-record repair ("heal-by-doing") |
| [0013 Unified Gesture Plans](0013-unified-gesture-plans.md) | gesture API/routing, contact topology, multi-touch geometry, native pointer injection, two-finger pan |
| [0014 Session Ref-Frame Lifetime](0014-session-ref-frame-lifetime.md) | ref authorization epochs, complete/partial issuance, pre-side-effect expiration, replay/batch compatibility, and cross-platform stale-mutation policy |
| [0015 Direct Maestro Compatibility Engine](0015-direct-maestro-engine.md) | Maestro YAML parsing/execution, compatibility observation policy, conformance, performance gates, gesture integration |

ADRs record *why*; the registries and gates they describe are the living source of truth — when
prose and a registry disagree, the registry wins and the ADR needs a follow-up.
