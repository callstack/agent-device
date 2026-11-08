# 0033. Collocation decision table

Status: accepted.

This decision evaluates the 48 candidate files in umbrella #3276 §5.
The [detailed table at the base commit](https://github.com/callstack/agent-device/blob/e35d0d496fb820d57d95fcad1b6b62dfa9962abb/docs/adr/0033-collocation-decision-table.md) records each decision and its rationale.
It is evidence for that audit, not a current file map.

## Decision

Judge collocation by ownership: the location that minimizes independently maintained declarations per change.
Community scores identify candidates only.
A detected community does not independently justify a move.
A shared foundation can belong to a consumer's community without belonging in that consumer's zone.

A move counts only when the target has a real seam.
A real seam adds no new dependency direction, pulls no root composition into a package, and keeps the file's own imports unchanged.
A `keep` decision is not a deferral.
Its rationale identifies the examined direction and why it fails.
An infeasible proposal does not get an issue to propose it again.
Moves use `refactor(move)` PRs.

A path-keyed rule such as R13, R76, or R78 describes a current seam and constrains a relocation.
It does not independently prove that the placement is best.
If only path evidence supports a row, mark it “retain for this batch — relocation requires coordinated ownership changes”.
The next pass reopens that row.
A package cycle rejects the proposed direction, but does not prohibit a future design that first removes the cycle-closing edge.

The allocator design withdrawal removed managed-allocation; see [ADR 0021](0021-simlock-leased-devices.md).
Nothing moves there now.
Rows that reject that destination or cite its capture-kit dependency as a cycle no longer bind.
Re-evaluate those files against their remaining edges.

Contracts keeps a vocabulary only when consumers in at least two higher-ranked zones use it; a single consumer zone cannot own it without an R5 spine inversion.
A vocabulary that only one zone uses, and that names that zone's own operations, belongs in that zone.

## Placement decisions

The detailed table retains the individual audit decisions.
Their ownership rationale follows.

| Owner | Decision and rationale |
| --- | --- |
| capture-kit | The capture admission ledger and durable JSON keep decisions rested on the managed-allocation cycle, so they no longer bind; re-evaluate them against their remaining edges. The rejection of durable JSON into contracts (R18) still binds. Keep snapshot evidence, freshness policy, and touch reference geometry below their platform, interaction, and daemon consumers. |
| contracts | Keep shared Android observation and system chrome, app events and state, device boot, interaction guarantees, and wait runtime vocabulary below their consumers. Keep the published contracts facade at the package boundary. The managed-device allocation port moved beside its sole implementing operations before that package was removed. |
| device-selection | Keep inventory context, selection resolver, dispatch resolution, and open-target vocabulary below daemon, remote, replay, and CLI consumers. |
| host-kit | Keep diagnostics, request cancellation and request contracts as shared seams. Keep session-path grammar below daemon, CLI, and platform consumers. |
| kernel | Keep device-isolation vocabulary below device-selection, replay-port, and daemon. |
| platform-android | Keep device boot mechanics in the platform. Root consumers are composition. |
| platform-apple and apple-runner | Keep the runner-owner seam and simulator boot mechanics in the platform; the kernel device model and xctestrun preparation must remain synchronized with them there. Keep legacy device-set parsers beside their runner. |
| replay-port | Keep the shard-device enumeration adapter at the daemon port. The replay-test scheduler never enumerates hardware by design; a move toward that zone would break the port. |
| selectors | Keep recorded-fill mechanics and target-evidence vocabulary below their consumers. |
| CLI and platform-runtime | Daemonless stale release moved beside the claim-recovery gateway in platform-runtime composition. R78 prohibits CLI access to daemon modules. |
| daemon-contracts | Shared daemon/client contracts belong below both sides. Keep the owner-scoped claim reconciler there because daemon open/startup and daemonless stale release both run it. Runtime recovery may reside there only when both sides run it and root composition supplies only the gateway. Capture-kit cannot depend back on daemon-contracts because that creates a project-reference cycle. |
| root composition | Keep the daemon bundle entry at the root. Retain the Apple runner-owner, daemon lifecycle, device boot, and resource-cleanup platform-runtime seams for this batch: relocation requires coordinated changes to R13 and R76. Keep Limrun runtime composition at the root because moving it into the provider package would pull root composition across the boundary. |
| command-runtime | The command binding and runtime factory moved into command-runtime. The binding retains the three-family daemon load shape. |
| SDK | Keep the published Limrun facade at the public boundary, because a published facade cannot reside in a private workspace package. Keep its public session-type refinement there: moving it into the provider package requires renamed or dual-exported internal types. |

Daemon credential composition remains at the root.
The daemon credential type belongs in daemon-contracts, and credential fingerprinting belongs with plugin manifest lookup.
Command-runtime and daemon-contracts derive zone ownership from packages and folders rather than per-file root-zone declarations.
Physical root-pass moves continue under #3294.
Logical zone declarations for root modules (#3288) do not count as completed collocation.

## Daemon package boundary

The daemon package has one entry, `.`, which explicitly exports by name what the daemon process root uses, including `startDaemonRuntime` and the types named by root composition and platform-runtime.
It has no `export *`.
This package boundary is the only permitted barrel; layer folders contain no barrels.
The transitional testing entries are gone.
A package value import evaluates the daemon server graph.
Root code that needs only command metadata reads that metadata's owner directly; route owner-file claims live in `@agent-device/command-registry/owner-files`.
Wire request and response types come from `@agent-device/contracts/command` and `@agent-device/kernel/contracts`.
Package tests import their subject relatively.
Composed root tests reach the daemon through `startDaemonRuntime` from the entry.
R83 owns the package entry surface.

The client-side policy prohibits every edge, type-only included, from the CLI, typed client, remote transports, and daemon client into the daemon package, including its entry.
R78 also prohibits access through any root module reachable by the CLI process.
The shared daemon-contracts zone sits below both daemon and client; R11 and package dependencies preserve that boundary.

## Rejected alternatives

- Move every ≥80% community match into its dominant zone: rejected because the measure describes consumers and reversed dependencies invert the spine.
- Move request-progress envelope validation to contracts: rejected because R18 excludes envelope validation mechanics.
- Move durable JSON mechanics to contracts: rejected because they validate durable-descriptor persistence, while R18 restricts contracts to wire vocabulary.
- Move ledgers to managed-allocation with capture-kit importing them back: rejected as proposed because the reverse edge would complete a package cycle. Removing the required import first would permit reconsideration; the allocator withdrawal now applies.

## Consequences

Shared foundations stay below their consumers instead of moving to the largest consumer's zone.
Path-keyed guards constrain relocation but do not settle ownership.
A future move can reconsider a rejected direction after its cycle-closing edge is removed.
