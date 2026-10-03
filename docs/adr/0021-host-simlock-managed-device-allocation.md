# ADR 0021: Host — Fresh Devices Through Simlock

## Status

Accepted (2026-09-01; scope amended 2026-10-01). This ADR defines the minimal Host integration.
[Simlock #70](https://github.com/callstackincubator/simlock/issues/70) tracks allocator-side work;
the supported client contract and conformance tests enforce the boundary.

Implementation alignment is pending: the [managed-device allocator contract](../../packages/contracts/src/managed-device-allocation.ts)
still requires `supersedeLeaseRequest`, `confirmLeaseActivation`, `getManagedIdentityStatus`,
and `acknowledgeManagedIdentityRemoval`, and exposes `activation: 'external-fence'`. Host implementation
must trim those requirements, their consumers/tests, and Android reuse documentation to this scope.
This amendment changes the decision and glossary; runtime contracts remain unchanged in this PR.

## Rules at a glance

- Host provides authenticated remote access, sessions, automation, and verification artifacts.
- Simlock is the sole owner of managed-device allocation, capacity, provisioning, and deletion.
- Every new managed Host lease gets a newly created, clean iOS simulator or Android emulator identity.
  Released or expired devices are deleted, never reset and leased again.
- Host uses Simlock's supported typed client over a local Unix socket. Simlock runs as a separate
  daemon; its core is not imported into agent-device.
- Allocation requests and Host lease mappings are durable. After a crash, Host queries Simlock
  before reattaching work, releasing it, or requesting a replacement.
- Commands require confirmed lease authority through their deadline and teardown. Abandoned Host
  leases stop renewing; Simlock expiry guarantees cleanup when Host cannot release them.
- One persistent service credential is sufficient for v1. Multi-user login, token rotation,
  warming, scheduled maintenance, and component preparation APIs are deferred.

## 1. Context

A remote verification worker installs a PR's CI build on a device and drives it with agent-device.
The initial deployment is a self-hosted Mac running agent-device Host and Simlock. Each verification
needs a clean starting state, and a crashed worker or daemon must not leak or duplicate devices.

`agent-device proxy` already provides remote transport, uploads, and artifact routes around a local
daemon. Host adds server-side shape allocation and recoverable lease coordination. Simlock already
owns the local allocator and platform lifecycle; building another allocator inside Host would
duplicate that authority.

Fresh devices on both platforms make the handoff simpler: there is no previous lease's state to
validate, no idle reusable identity to protect, and no warm pool to coordinate. This accepts the
provisioning and boot cost of each lease in exchange for a uniform isolation guarantee.

## 2. Integration

```text
remote verification worker
  -> Host front-end
      -> agent-device daemon and managed runtime
          -> Apple/Android automation
          -> typed Simlock client over a local Unix socket
              -> Simlock daemon and fresh managed device
```

## 3. Ownership and runtime composition

| Owner | Authority |
| --- | --- |
| Host front-end | HTTPS, service-credential authentication, trusted client identity, public route policy |
| agent-device daemon | Host leases, sessions, automation, artifacts, durable allocation handoff, request admission |
| Simlock | Shape resolution, capacity, provisioning, readiness, managed-device leases, expiry, deletion, allocator recovery |
| Apple/Android runtime | Automation mechanics for the admitted device |
| Process manager | Start and restart Host and Simlock |

A Host lease authorizes a remote verification job. Its mapped Simlock lease owns local allocation
and device lifecycle. Host records the mapping and delegates allocation; it does not maintain a
second device manifest, capacity counter, provisioning queue, or cleanup engine.

The managed runtime remains the one outward owner under ADR 0019. It delegates automation to the
platform runtime and device lifecycle/readiness to Simlock. It never falls back to direct `simctl`,
`adb`, or emulator lifecycle operations. App and session teardown remains agent-device-owned.
Existing device-claim and helper exclusion applies during execution.

Ordinary local devices, plain `proxy`, and external providers keep their existing lease models.
Simlock is an implementation detail of Host, not a public `leaseProvider` or `connect simlock` mode.

## 4. Allocation and crash recovery

The supported Simlock client must let Host acquire a ready fresh device, recover an allocation
request by lookup or replay, inspect current lease authority, renew a lease, and release it.
These are capabilities, not prescribed method names. No reusable-identity activation confirmation,
warm-identity status, or removal-acknowledgement handshake is required by Host v1.

Before acquisition, Host durably records the verification job, restart-stable requester,
idempotency key, immutable shape, and request deadline. After Simlock responds, Host records the
allocator outcome and lease handle before publishing the Host binding. An uncertain publication
is recovered conservatively rather than treated as proof that the job never received a device.
The journal records this handoff only; Simlock remains authoritative for allocation and lifecycle.
A conflicting ordinary agent-device claim prevents publication of an executable Host binding.

Replaying the same request returns its durable outcome without creating another device. A terminal
refusal remains terminal under that key, and different input under the same key is refused.
A retry after a terminal result uses a new key. A lost response or disconnected wait does not
establish that allocation failed; Host reconciles the original request before retrying or abandoning
it. If provisioning cannot be canceled, Host waits for the outcome and releases any resulting lease.

After Host or Simlock restarts, Host reconciles outstanding journal entries through Simlock:

- A confirmed live lease for a still-authorized job may reattach through normal runtime admission.
- An abandoned job is torn down and its pending request canceled or granted lease released.
- A missing, expired, or terminal lease cannot authorize execution; stale Host state is cleaned up.
- An uncertain result stays non-executable until Simlock confirms its outcome.

Recovery does not promise that a lease survives a Simlock restart. It promises that Host can learn
what happened and cannot invent authority or allocate a duplicate. Replacing abandoned work uses
ordinary cancellation or release after execution teardown, then a new allocation request once
Simlock admits it. Atomic same-requester supersession is not a Host v1 requirement. A capacity-one
host waits for confirmed cleanup instead of forcing a replacement through occupied capacity.

Simlock owns disk and capacity admission. Host requests fail-fast allocation and adds no second
queue or disk heuristic. Capacity refusal uses ADR 0010 `details.reason: "simulator-capacity"` with
`retryAfterMs`; low disk uses `details.reason: "disk-low"` without `retryAfterMs`.

## 5. Shape selection and fresh-device policy

Host accepts a shape such as `{ platform: 'ios', deviceType: 'iPhone 16', osVersion?: string }`.
On Host, `--device "iPhone 16"` or `--device "Pixel 7"` sends the shape without resolving a local
inventory identity first. Simlock resolves it against installed components. An omitted OS selects
the newest compatible installed runtime; an explicit major selects the newest compatible installed
minor; an exact version must match an installed version.

Every new managed Host lease creates a new iOS simulator or Android AVD with a new incarnation and
clean initial user data. It never uses a device or mutable device snapshot from an earlier lease.
Renewal or recovery of the same live lease keeps its identity; neither creates a new lease.
An Android transport serial or port is an address, not proof of a fresh device identity.

Simlock deletes the identity after release, expiry, or recovery-driven termination. Failed or
uncertain deletion remains Simlock-owned and unavailable for leasing; capacity is not freed until
deletion is confirmed. Host never substitutes reset-and-reuse or direct deletion for this policy.

Host uses a dedicated Simlock home, owned iOS device set, Android AVD root, and scoped transport.
Managed identities are absent from public inventory and ordinary selector resolution. Public
requests cannot select host paths, override allocator policy, or address a managed device by raw
UDID or serial outside its Host lease.

Components are installed by the operator before allocation. Missing components produce a typed
refusal; an ordinary lease request never triggers a download.

## 6. Remote access and artifacts

Host v1 uses one persistent service credential mapped to a server-controlled identity. The
front-end strips client-supplied identity and forwards requests over a daemon-token-authenticated
loopback channel. Public routes explicitly refuse allocator administration and host-local paths;
anonymous health exposes only minimal status. A full per-user credential registry and live token
rotation/revocation protocol are outside this scope.

Host installs the exact verification build through existing `install-from-source` support for
URLs and GitHub Actions artifacts, including private-artifact authentication. Verification output
is available through Host's artifact transport. Simlock owns neither uploads nor job artifacts.

## 7. Renewal, abandonment, and release

Before admitting a command, Host confirms that the Simlock lease covers the command deadline plus
canonical teardown, including recording finalization. Unbounded work requires a bounded request.
Renewals use Simlock-confirmed deadlines and may be coalesced per lease. A failed or uncertain
renewal fences the affected binding until lookup confirms authority or teardown completes.

Host leases have a finite expiry renewed by the worker. While a Host lease is authorized, Host
keeps its Simlock lease alive, including between commands. When the worker disappears and its Host
lease expires, Host stops renewing, cancels or drains work, completes session/helper teardown, and
releases the Simlock lease. A Host crash cannot prevent eventual Simlock expiry and deletion.

Release fences new execution and proves runner quiescence before giving the device back to Simlock.
Release and uncertain responses are recoverable across restart. Host never executes beyond
confirmed lease authority or reuses a terminated binding. Ordinary execution exclusion does not
require claims held between jobs because terminated identities are never leased again.

## 8. Installation and protocol

Installation persists the credential, Host journal, and paired versioned configuration. A process
manager restarts both daemons. Host starts allocation and execution only after compatible Simlock
connectivity and recovery. Host authentication and server-side shape allocation require the RPC
protocol change under ADR 0006; plain proxy behavior remains unchanged.

The adapter depends on Simlock's supported typed client package. Protocol mismatch fails before
mutation. Host never shells out to the Simlock CLI or imports private allocator/driver modules.

## 9. Deferred work and rejected alternatives

Multi-user login, live token rotation/revocation, scheduled maintenance, automated component
preparation, paired-update rollback, and richer artifact management are separate follow-ups. They
do not block the initial remote verification flow or crash recovery.

Device reuse and warm inventory are outside Host's fresh-per-lease policy. Introducing either
requires a new isolation decision; a Simlock feature for other clients does not change Host policy.

- **Reset and reuse Android devices:** rejected for Host because it adds baseline restoration and
  between-lease handover coordination that fresh identities avoid.
- **Provision inside agent-device:** rejected because Simlock already owns allocation and lifecycle.
- **Expose Simlock as the remote provider:** rejected because Host owns remote access and automation.
- **Replace every agent-device lease:** rejected because remote authorization, allocator lifecycle,
  and helper exclusion remain distinct responsibilities.

## 10. Acceptance

The integration must prove both iOS and Android behavior through the real Simlock client:

1. From another machine, a worker acquires a device by type, installs its CI build, opens the app,
   takes snapshots, interacts, retrieves verification artifacts, and releases the lease.
2. Successive managed Host leases use distinct created identities and clean user data. Simlock deletes
   each terminated identity; failed deletion never enables reuse or frees capacity prematurely.
3. Lost allocation responses, repeated requests, and crashes during provisioning or Host binding
   publication produce no duplicate or untracked allocation. Restart recovery can identify and
   reconcile Host's outstanding requests and leases.
4. A 20-minute verification exercises renewal. No command starts or continues outside confirmed
   authority, and worker disappearance or Host death leads to lease expiry and deletion.
5. Concurrent verification jobs renew independently within capacity. Capacity-one replacement
   waits for prior execution teardown and allocator cleanup. Conflicting ordinary execution is
   refused, and no managed lifecycle operation bypasses Simlock.
6. Public callers cannot spoof identity, call admin operations, select host paths, or enable
   component downloads. Incompatible protocol versions fail before mutation.
