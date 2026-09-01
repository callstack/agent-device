# ADR 0021: Host — Simlock-Backed Managed Device Allocation and the Host Supervisor

## Status

Accepted (2026-09-01). The local managed-device slice and the upstream dependencies tracked in
[Simlock #70](https://github.com/callstackincubator/simlock/issues/70) gate implementation. This ADR
owns the architecture and safety invariants; contracts, registries, schemas, CLI help, and
conformance tests become the executable sources of truth.

## 1. Context

`agent-device proxy` is a thin reverse proxy in front of one local daemon: full JSON-RPC
passthrough, one shared bearer token, client-declared tenant identity, and upload/artifact routes.
Remote device leases (ADR 0007), resumable uploads, tenant-scoped sessions and artifacts, RPC
versioning (ADR 0006), and request-bound platform runtimes (ADR 0019) already exist.

A shared, self-maintaining Mac also needs per-user identity, shape allocation, managed device
lifecycle, capacity, component preparation, supervision, retention, and safe maintenance.
[`callstackincubator/simlock`](https://github.com/callstackincubator/simlock/tree/67255ca3f7d363bccca6515eab5fd01fdbc6caa6)
already owns most of that local allocator problem behind Apple and Android drivers. It is local by
design: its clients use a Unix socket and its grants contain host-local UDIDs or ADB serials. It
does not own remote HTTP, tenant authorization, Host sessions, artifacts, or automation transport.

Putting another provisioning engine in agent-device would create competing state machines. Making
Simlock the public remote provider would force it to recreate Host. The chosen composition keeps
one owner for each problem.

## 2. Decision

1. **Proxy and Host are distinct exposure policies.** `agent-device proxy` remains the ad-hoc
   shared-token front-end. `agent-device host` adds per-user authentication, managed allocation,
   and supervision over the daemon protocol.
2. **Simlock is the sole managed-device allocator.** It owns shape resolution, component
   preparation, provisioning, capacity, warm inventory, boot/shutdown policy, health, quarantine,
   reclaim, deletion, and allocator recovery. Agent-device has no parallel device manifest,
   capacity counter, provisioning queue, or destructive fallback.
3. **The lease layers stay distinct.** A Host device lease authorizes a remote user. A Simlock
   managed-device lease owns local allocation exclusivity and lifecycle. Agent-device records their
   mapping but never treats one as the other.
4. **One managed runtime binds each grant.** The outward runtime owner is selected once. It delegates
   automation mechanics to the Apple or Android runtime and all managed-device lifecycle/readiness
   work to Simlock. Handlers never resolve a second lifecycle owner or fall back to direct
   `simctl`, `adb`, or emulator lifecycle commands.
5. **Simlock remains a local implementation detail.** Remote clients connect to Host over HTTPS;
   Host connects to a co-resident Simlock over its supported local client contract. No public
   connection profile, `leaseProvider`, or runtime plugin ABI exposes Simlock.
6. **Authentication terminates at the Host front-end.** It strips all client-supplied identity and
   injects the authenticated principal `{ tenantId, userId, credentialId }` over a
   daemon-token-authenticated loopback channel.
7. **Administration is a separate boundary.** Host operator methods and Simlock administration are
   loopback-only, daemon-credential-authenticated capabilities. Public route and method allowlists
   deny them explicitly.
8. **Name-only device selection allocates a shape.** On Host, `--device "iPhone 16"` requests a
   managed shape; the client sends that shape instead of resolving it to an inventory UDID first.
   An explicit UDID/device key addresses an existing unmanaged device and is refused if it belongs
   to the managed pool. Managed identities are absent from public inventory and ordinary selector
   resolution.
9. **Preparation is explicit.** Missing components are never downloaded because of an untrusted
   lease request. Authorized install/admin policy asks Simlock to prepare them, with disk admission,
   durable progress, and a terminal result.
10. **Artifacts remain Host-owned.** Simlock owns no tenant uploads, artifacts, diagnostics, or
    retention policy.
11. **Maintenance crosses one deep boundary.** Host proves execution quiescence; one durable,
    idempotent Simlock maintenance epoch owns allocator drain, release, settle, reconciliation,
    restart recovery, and resume. Host never choreographs those internal lifecycle steps.
12. **Pinned updates preserve the process boundary.** Host preflights a compatible agent-device and
    Simlock pair, retains the previous pair, and supports rollback. Repository colocation does not
    merge their authority or durable state.

## 3. Ownership and runtime composition

```text
local integration or remote Host request
  -> agent-device daemon
      -> one managed local-runtime binding
          -> Apple/Android automation mechanics
          -> Simlock client over a Unix socket
              -> managed simulator or emulator
```

| Owner | Authority |
| --- | --- |
| Host front-end | TLS, token authentication, asserted principal, public status |
| agent-device daemon | User authorization, Host sessions/leases, request admission, artifacts, allocation-operation journal, managed runtime binding |
| Simlock | Shape resolution, preparation, managed-device leases, lifecycle, capacity, health, warm inventory, and GC |
| Apple/Android runtime | Automation mechanics delegated by the managed runtime, excluding managed-device lifecycle |
| Host supervisor | Process recovery and scheduled maintenance through the two local admin boundaries |

Four independent guards remain because they protect different things:

| Guard | Purpose |
| --- | --- |
| Host device lease | Remote user authorization and attribution |
| Simlock managed-device lease | Allocation exclusivity and destructive lifecycle authority |
| Managed-device execution claim | Excludes non-Simlock-aware agent-device daemons from the local identity |
| Platform helper/runner lease | Protects the automation helper process below the managed runtime |

The managed runtime is the only outward ADR 0019 runtime owner. Its internal delegation is not a
handler-visible fallback. Registry completeness gates reject any command path that can bypass the
binding for managed-device readiness, boot, shutdown, erase, reclaim, or deletion. Ordinary app and
session teardown still belongs to agent-device; device lifecycle does not.

The local-first slice binds this runtime without Host HTTP, identity, or artifacts. Host later adds
authorization and attribution around the same boundary. Plain local device selection and plain
`proxy` retain their existing behavior; this ADR does not create `connect simlock`.

## 4. Allocation and recovery contract

### Host journal versus allocator state

Before acquisition, agent-device durably records a non-authoritative allocation operation: the
logical requester, idempotency key, immutable shape request, deadline, and Host attribution when
applicable. After Simlock responds, it records the allocator handle/outcome and whether Host
published or cleaned it. This journal exists only to recover the Host-to-Simlock handoff. It never
mirrors Simlock's queue, provisioning, lease, cleanup, health, or capacity states, and it never
decides whether a device is reusable.

Each logical requester is a restart-stable allocation lane; concurrent leases use distinct lanes.
Replaying the same attempt key returns the same durable outcome, including a refusal. Disconnect,
request timeout, or abort abandons only the caller's wait. A request terminalizes through explicit
cancellation, authorized supersession, or a stored allocation outcome that can no longer publish a
grant. Capacity, disk, validation, and provisioning failures are terminal for that attempt even
while any device settlement remains capacity-bearing. An uncertain result is always reconciled
through Simlock lookup.

A terminal failure is never re-evaluated under the same attempt key. Retrying after a retriable
capacity refusal uses a new key after `retryAfterMs`; retrying a disk refusal uses a new key only
after operator remediation. Simlock admits that key as the next generation without supersession
because the prior generation can never grant. A nonterminal prior generation still requires
authorized supersession.

Replacing a nonterminal attempt or live binding on the same lane requires agent-device to fence the
old binding, drain admitted commands, complete canonical session teardown, and prove no runner can
still mutate the device. Simlock then atomically supersedes exactly the expected prior generation
and installs the replacement attempt. Replays return the same outcome; stale generations or
different replacement payloads fail without mutation. This permits capacity-one crash healing
without letting a new key revoke live work.

Host asks Simlock for fail-fast allocation. Capacity refusal maps to retriable ADR 0010
`details.reason: "simulator-capacity"` with `retryAfterMs`; Host adds no second queue. Simlock performs
disk admission before every create, clone, or authorized component download. Low disk maps to
non-retriable `details.reason: "disk-low"` without `retryAfterMs`; Host adds no second disk heuristic.

### Execution claims and reusable Android identities

An ordinary device claim ends with its session or command. A managed-device execution claim instead
lasts for the allocator-owned identity's full pool lifetime and is cleared only after Simlock proves
that identity removed. Active managed sessions execute under it rather than replacing it. Stale
claim recovery revalidates Simlock ownership and never performs direct lifecycle cleanup.

The claim store therefore gains an explicit allocator-backed claim kind with its own durable owner
and release rules. It is not encoded as a synthetic session and cannot inherit session-close
clearing or stale-process cleanup without allocator revalidation.

Reusable Android identities require a fenced activation handshake: Simlock reserves the identity,
agent-device acquires or reattaches its execution claim, and Simlock validates the clean baseline
under that fence before the grant is published. A conflicting ordinary claim prevents publication.
The execution claim remains through idle/reclaim intervals, so a known serial cannot be mutated by
another agent-device daemon between Host leases. This extra guard is execution exclusion only;
Simlock remains the allocator and lifecycle owner.

### Renewal, release, and restart

Before admitting a command, Host confirms that the Simlock lease covers the command deadline plus
canonical teardown. Renewals are allocator-first, amortized outside the safety window, and coalesced
per managed-device lease. A failed or uncertain renewal fences only the affected Host/managed-device
binding, reconciles through Simlock, and either publishes the confirmed deadline or tears down. No
command continues on Host's cached deadline alone.

Release is durable and retryable. Host does not publish a replacement grant while Simlock may still
mutate the device. After either daemon restarts, the journal is reconciled through Simlock lookup: a
live, authorized mapping reattaches; missing, terminal, stale, or unauthorized work follows
canonical cleanup. Simlock remains the only source of capacity and lifecycle truth, and Host status
projects rather than reconstructs it.

## 5. Shape and isolation policy

A managed shape is `{ platform, deviceType, osVersion? }`. Simlock owns canonical resolution against
its installed catalog. Omitted OS selects the newest installed runtime; an explicit major selects
the newest compatible installed minor; an exact version must match or enter explicit preparation.

Host v1 includes both iOS and Android, with deliberately asymmetric isolation:

- iOS receives a new simulator UDID per Host lease and deletes it after release.
- Android starts from Simlock's validated clean baseline but may reuse the same serial.

Clean-state reuse is not fresh identity. Help and public or operator-facing documentation must
qualify every freshness claim by platform. Changing either guarantee requires an ADR amendment.

Warm inventory remains Simlock-owned. Simlock computes admission against every capacity dimension a
warm device consumes—including platform managed/running limits and the global running limit—and
reserves a cold-demand slot in each applicable dimension. Capacity remains charged until
eviction/deletion is confirmed. Current defaults live in versioned install configuration and help,
not in this ADR.

`host install` creates a dedicated Simlock home and writes paired versioned configuration. Simlock
owns its socket/home, validated iOS device-set root, capacity and warm policy, iOS fresh-identity
policy, Android clean-baseline policy, and disk floor. The Host adapter owns compatible protocol
range and renewal/teardown timing. Requests cannot override any of them.

Preparation commands remain ADR 0019 `platformExecution: host` operations behind a neutral
allocator-admin service; command handlers do not import either platform driver.

## 6. Identity, authorization, and revocation

One Host deployment serves one tenant with attributed users; multi-tenant deployment uses separate
Hosts. Reads are tenant-wide. Mutation of a session, Host lease, upload, artifact, or diagnostic is
authorized by `ownerUserId`, so any active credential for that user can continue the work. Forced
release or termination exists only on the admin surface.

Every attributed resource stores immutable `ownerUserId` and `createdByCredentialId`; each request
audits `actedByCredentialId`. Live execution resources also store `controlCredentialId`, which is
the emergency-revocation fence. Revocation does not delete durable uploads, artifacts, or
diagnostics; their mutation remains user-authorized.

Credential states are `active`, `retired`, and `revoked`. Rotation creates a new credential, changes
all of that user's live `controlCredentialId` values in one daemon transaction, and only then retires
the old front-end credential. A failure leaves the old credential active rather than orphaning work.
Already-admitted work may finish; rotation does not trigger emergency teardown.

One daemon `HostAdmissionCoordinator` serializes credential state and the maintenance epoch before
every Host heartbeat, session mutation, runtime binding, or device operation, then indexes admitted
work by credential, user, and resource. Existing resource locks run after this admission point.

Revocation linearizes at a durable daemon credential fence. From that point, even an already
authenticated and forwarded request cannot begin execution. The front-end registry is then marked
revoked, and `host tokens revoke` returns only after both boundaries acknowledge the fence. Work
already admitted is canceled or drained; credential-controlled sessions and leases follow durable,
retryable teardown. Cleanup failure is observable and may quarantine ownership, but never weakens
the security fence.

The principal and attribution fields persist on sessions, Host leases, uploads, artifacts,
diagnostics, allocation operations, and mappings. The built-in token registry runs at the outer
front-end, where the original credential is visible; it is not mounted behind the daemon auth hook.
The hook contract must carry the complete trusted principal or fail compatibility negotiation—no
identity is inferred downstream.

## 7. Maintenance, artifacts, and supervision

Refill/preparation, maintenance, reconciliation, token administration, and forced termination are
loopback-only admin methods. Attributed status requires a user token; anonymous `/health` remains
minimal.

The scheduled maintenance window may end healthy leases after a configurable allocation grace and
may be disabled. When it runs, the durable supervisor:

1. Persists a maintenance epoch, fences new allocations, then fences and drains device mutations.
2. Ends Host leases, performs canonical session teardown, releases their managed-device leases, and
   proves zero live runner. Only the local managed adapter receives the resulting unforgeable
   quiescence capability; it calls Simlock prepare-maintenance with the epoch alone.
3. Simlock internally drains every lifecycle producer, releases remaining leases, settles,
   reconciles only ownership-verified devices, and persists a restart-safe drained result.
4. Sweeps only expired, unpinned artifacts inside the Host artifact root. Unknown expiry and
   symlinked entries are refused. No global DerivedData, temporary, or developer-device roots are
   maintenance targets. Caller-path delete-after-download state remains in memory and never becomes
   a durable sweeper entry.
5. If configured, restarts CoreSimulatorService, Simlock, and agent-device in that order. The
   persisted epoch starts Host fenced and Simlock drained.
6. Invokes Simlock resume for the same epoch. Simlock completes startup reconciliation and advances
   warm convergence until ready or until a reusable identity needs its external execution claim.
7. While Host remains fenced, the local managed adapter acquires or reattaches every requested
   managed-device execution claim and idempotently confirms fenced activation. Replaying resume
   continues the same epoch until Simlock reports warm convergence ready.
8. The supervisor runs both doctors, retains the report, emits failure/disk webhooks, then removes
   the Host epoch and reopens admission.

The Host epoch has no TTL. Supervisor death leaves Host fenced and Simlock drained until the
restarted supervisor or loopback-only operator recovery completes the same epoch. A configuration
may disable the whole window or non-destructive suffixes; it cannot enable destructive work without
the safety prefix. A different prepare epoch fails without mutation while one is active, and stale
resume/activation messages cannot clear or advance a newer epoch.

Continuous artifact GC remains Host-owned. Continuous managed-device GC remains Simlock-owned. The
supervisor owns process recovery and scheduling but exposes no network service.

## 8. Protocol and packaging

Host authentication semantics and server-side shape-allocation sequencing require an agent-device
RPC protocol bump under ADR 0006. Plain proxy behavior does not change.

Simlock exposes a supported, typed, versioned local client for every operation Host consumes.
Version skew fails before mutation. Host never shells out to the Simlock CLI, imports Simlock core
internals, or dynamically loads an arbitrary provider module.

The adapter's package location is an implementation choice under R13/R65. Its semantic contract,
single managed runtime owner, lifecycle exclusion, and protocol compatibility are not.

## 9. Consequences and rejected alternatives

The composition adds a second daemon and a versioned local protocol, but removes an entire duplicate
allocator/lifecycle state machine from agent-device. Local execution can reuse Simlock before Host
exists, while ordinary local devices and external providers keep their current lease models.

- **Provision inside agent-device:** rejected because it duplicates Simlock's capacity, recovery,
  quarantine, warm inventory, and destructive ownership.
- **Expose Simlock as a remote device provider:** rejected because Simlock grants a local identity; it
  does not own remote transport, tenant authorization, artifacts, or automation behavior.
- **Replace every agent-device lease with Simlock:** rejected because Host authorization, local
  lifecycle ownership, peer-execution exclusion, and helper mutual exclusion are different guards.
- **Integrate only after Host exists:** rejected because the local managed-runtime slice proves the
  hard lifecycle boundary before adding HTTP and identity.
- **Load arbitrary provider modules:** rejected because that needs a separate trusted plugin model,
  stable public ABI, config/secrets contract, lifecycle, compatibility policy, and acceptance of
  daemon-privileged code execution.

## 10. Acceptance invariants

Implementation issue checklists may refine operation-level acceptance without weakening the
following lasting architecture invariants.

The local slice must exercise iOS and Android acquire, open, automation, close, release, renewal,
restart, cancellation, same-requester healing, concurrent requester lanes, and contention from both
Simlock-aware and ordinary agent-device daemons. It must prove that no managed identity becomes
executable before its claim and no Android reusable identity becomes unclaimed between leases.

Final acceptance requires:

1. No duplicate, unattributed, or over-capacity allocation across disconnects, retries, or either
   daemon restarting.
2. No command starts without authorization or beyond a confirmed managed-device lease horizon;
   revocation linearizes before cleanup and maintenance fails closed across supervisor death.
3. iOS fresh identity, Android clean reuse, explicit preparation, disk admission, and ownership-safe
   deletion hold under adversarial races and state corruption.
4. One client connection independently renews concurrent managed-device leases up to capacity;
   capacity-one replacement proceeds only after the prior execution binding is quiescent.

Conformance covers identity spoofing, authorization, public-admin denial, revoke/request races,
allocation cancellation and supersession, lost responses, long-command renewal, low disk,
unauthorized downloads, corrupted state, cleanup quarantine, Android idle-serial exclusion,
maintenance death/restart, and paired-version rollback.

## 11. Open implementation choices

- Exact wire and persisted record schemas, migrations, and descriptor representation.
- Exact package placement for Host and the managed Simlock adapter.
- Whether the supported Simlock client ships as one package export, a separate package, or a
  workspace package.
