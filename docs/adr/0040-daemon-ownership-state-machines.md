# ADR 0040: Daemon ownership and request state machines

## Status

Accepted. Implementation and mixed-version validation are pending.

## Rules at a glance

- Prove authority over the exact session lifetime before a request reads or changes session state, probes resources, or writes the session journal.
- Bind the lease at session creation. Refuse a cross-owner reopen before launch.
- For an expired lifetime, use one daemon-owned `settleExpiredLifetime(lifetimeId)` job. Await it outside execution locks. Only `open` with its own valid lease can replace the expired lifetime.
- Give remote outputs daemon-chosen destinations and IDs. Retain producer proof with each output. Use one visibility rule for session names.
- Keep one transition table as data for each machine. Derive or check the exhaustive switch, per-row tests, and ADR tables against that data. Log each transition with actor, event, old state, and new state.

## Context

The lease ID is the bearer credential. Tenant, run, backend, client, device, and provider labels constrain it. An address can refer to several session lifetimes in succession. Authority must survive that distinction, including in retained outputs and visible session names.

The store exposes reads and journals by address. Replay uses address-based operations. After unlock, script finalization can resolve the replacement lifetime. An `open` can attach a first lease to a live session. Lease expiry can race provider release, and finalization can infer the wrong output owner. The [baseline evidence](../evidence/daemon-session-authority-0.22.md) records the paths and raw-read count. Keep the regression coverage from [#4944](https://github.com/callstack/agent-device/pull/4944) and [#4945](https://github.com/callstack/agent-device/pull/4945).

## Decision

Each machine has one transition owner. Other modules send events. The coordinator orders cross-owner work under the existing execution locks. Refuse unlisted transitions unless the owner declares them idempotent.

### Lease — `LeaseRegistry`

| State | Event and guard | Next state and effect |
| --- | --- | --- |
| Absent | Allocate with a fresh ID | Allocating. Reserve the contention key. |
| Allocating | Provider succeeds while allocation is wanted | Active. Deliver the credential. |
| Allocating | Failure, cancellation, or late success after cancellation | Ending. Track the unresolved create. |
| Active | Heartbeat, wanted work, or close with `retainOnClose` | Active. Wanted work defers expiry and renews on completion. Cancellation removes that protection. |
| Active | Effective deadline, explicit release, confirmed provider end, ordinary close, or shutdown | Ending. Revoke admission before teardown. |
| Ending | Retirement and release confirmed | Ended. Permit reuse when the affected resources are safe. |
| Ending | Cleanup or release uncertain | Ending. Keep the reservation and retry eligible work. |
| Ended | Cleanup or receipt retention ends | Absent. Keep the old credential unusable for admission. |
| Startup | Inherited rental or legacy provider journal entry | Ending. Restore its reservation before overlapping admission. |

At the deadline, check wanted work, holds, and generation before marking `Ending` in the same decision. Schedule the deadline and use the sweep as a backstop. One lease end record covers all sessions, any retained host, and provider release. Keep the `retainOnClose` idle-daemon rule. Once a reservation fences reuse, release the exact provider instance outside execution locks in backend order. An overlapping allocation waits outside locks or returns typed contention. The outermost response reports each lease end once, including on failure. Reserve the lease ID while it can authenticate retained output.

Before a billable create, durably record its contention scope and a fingerprint of the lease ID. When the provider supports reconciliation, record its allocation key before submission. Record the exact instance when the provider identifies it. The rental entry authorizes release after restart and remains until release or absence is confirmed. After registration, reconstruct the reservation in `LeaseRegistry`. Recover by exact identity when known, or use the provider's reconciliation key to find the instance. If the journal has a credential fingerprint, require it to match before making a provider call. A provider can report absence only when it can rule out a late create. An empty lookup alone cannot do so. Keep an unresolved reservation as `release unknown` for the operator.

Register pending holds and admit mutations through one synchronous decision, including on first open. A pending hold fences mutations and becomes active after admitted mutations drain. Cancellation removes only that pending generation. When the last hold ends, restart inactivity timing at release or expiry. Active leases still accept heartbeats. Holds coexist with claims and vanish on restart. Keep host hold and `macos-app` admission rules.

### Session lifetime — `SessionCoordinator`

| State | Event and guard | Next state and effect |
| --- | --- | --- |
| Absent or Retired | Authorized creation at the address | Opening. Reserve a fresh lifetime. |
| Opening | Ready and still admitted | Open. Publish through the reserved slot. |
| Opening | Failure or cancellation | Retired. Roll back resources from this attempt. |
| Open | Same-owner reopen | Open. Keep the lifetime and its lease. |
| Open | Close, idle expiry, lease end, or drain | Closing. Drain or fence live effects. |
| Closing | Cleanup settles | Retired. A retained execution host belongs to the lease. |
| Closing | Retryable explicit close with unresolved effects and a held claim | Close pending. Keep the claim and refuse ordinary mutations. |
| Close pending | Authorized retry or teardown | Closing. Check the same lifetime. |

Bind the lease or explicit unleased state when any command creates a session. This includes recording-only and snapshot-only creation. Before relaunch, refuse a live cross-owner reopen with a typed error. The old owner can close, then the new owner can open a fresh lifetime.

Publish one `settleExpiredLifetime(lifetimeId)` job before its first asynchronous operation. The sweep, owner request, and valid successor `open` await that job. Use daemon bindings and diagnostics. Under session and device locks, verify lifetime, lease generation, and claim token. Finish owned captures. Settle runtime effects before clearing the exact claim. If export fails after stop, preserve retry material. If stop is unconfirmed, keep the resource fenced. If expiry wins, return `LEASE_NOT_FOUND` to the owner. An owner `close` can report the confirmed end within its budget without dispatching a second close.

### Device claim — host-global claim owner

| State | Event and guard | Next state and effect |
| --- | --- | --- |
| Free | Exclusive acquisition | Held by request. Check host and app device overlap. |
| Held by request | Matching lifetime publishes | Held by session. Transfer the exact owner token. |
| Held by request | Completion, failure, or abort settles | Free or Unresolved. Use the exact owner token. |
| Held by session | Close, idle expiry, or lease teardown | Free or Unresolved. Use the token of the retiring lifetime. |
| Unresolved | Owner proves stale, rebooted, or settled | Free. Until then, overlapping reuse is fenced. |

After restart, inspect durable claim records under the host-global lock. Apply descriptor policy to observations. Keep provider-side contention with the lease provider.

### Request — dispatcher

| State | Event and guard | Next state and effect |
| --- | --- | --- |
| Intake | Transport authenticates and decodes | Planned or Refused. Keep attested routing and all supplied labels. |
| Planned | Scope and descriptor choose lock keys | Waiting or Locked. Spend device wait budget outside execution locks. |
| Waiting | Device state changes | Planned. Resolve the lock keys again. |
| Waiting | Budget ends or caller cancels | Refused. End the caller's wait. |
| Locked | Re-resolve and check proof and policy | Admitted, Replan, Need settlement, or Refused. Prove authority before resource probes. |
| Replan or Need settlement | Drop locks, then await settlement if required | Planned or Refused. Recheck scope, generation, device, hold, and claim. |
| Admitted | Obtain applicable work and mutation passes | Acting. Bind journal and recording probes to the admitted lifetime. |
| Acting | Result, throw, or abort | Finalizing. Abort revokes authority and renewal. Keep exclusion until unsafe effects settle or are fenced. |
| Finalizing | Commit lifetime effects under lock | Done. After unlock, serialize committed outputs and the outermost lease-end ledger. |

Decode released lease label aliases once. Remove an alias only with wire evidence and a deprecation decision. Refuse contradictions, including values displaced by attestation or nested scope. Detached inventory uses permitted views. Session `doctor` and events need a pinned lifetime. Listing, progress, and errors use the same visible-name projection. Keep the explicit local exception for device recovery.

If a request detects expiry, confirm under lock before session effects. Refuse missing, wrong, or contradictory proof without disclosing old ownership. A valid successor `open` waits for the first settlement attempt within its deadline. When supplied, apply `--wait` too. Give waiting callers no work pass or renewal. If reuse is still uncertain, return typed, retryable contention. On wake, replan the address and device. Under the new locks, recheck the successor lease before admission. Competing successors use ordinary contention rules. Cancellation ends only the caller's wait. Owner requests stay pinned to the original lifetime.

Check expiry before taking the outer locks of `batch`, `replay`, or another composite. Under those locks, each step checks inherited scope and its actual lifetime. A step must never re-enter a held lock or await settlement with outer locks held. If expiry or a lock conflict requires that wait, fail through the step contract and unwind. Preserve completed progress and replay source. After unwind, the daemon job can proceed.

### Output — `OutputRegistry`

| State | Event and guard | Next state and effect |
| --- | --- | --- |
| Absent | Producer reserves an output | Reserved. Mint a unique ID and destination. Bind immutable producer proof. |
| Reserved | File or provider reference passes validation | Available. Commit the output before delivery. |
| Reserved | Producer aborts | Discarded or Recovery pending. Grant no download access. |
| Recovery pending | Authorized recovery verifies the original reservation | Available or Discarded. Use the original producer proof. |
| Available | Reader satisfies retained-output admission | Available or Consumed. Apply the kind's retention rule. Stream the same file descriptor that was verified. |
| Available | Retention deadline | Expired. Refuse reads. |
| Consumed, Expired, or Discarded | Cleanup or repeat cleanup | Same state. Clean only that reservation's storage and identity. |

Retained leased output requires canonical scope and the producing lease verifier, including after close. Keep the bounded tenant lookup for provider artifacts after close until a producer receipt exists ([#4950](https://github.com/callstack/agent-device/issues/4950)). For refusal diagnostics, use a detached opaque record ID with the presented lease verifier or an explicit unleased marker. Use daemon destinations for remote output. Keep `--out` client-local and host paths on the trusted local lane. Commit script revisions under lock. Stream committed bytes after unlock.

### Code shape and enforcement

`SessionCoordinator` keeps `SessionStore` private and uses `SessionRef` internally. It alone constructs both types with private brands inside the admitted callback. Operations check revocation and lifetime at runtime if a reference escapes. Routes receive only the domain operations they declare.

```ts
declare const sessionAuthority: unique symbol;
declare const openAuthority: unique symbol;

interface AuthorizedSession {
  readonly [sessionAuthority]: true;
  view(): SessionView;
  readonly journal: BoundJournal;
}

interface AuthorizedOpenSlot {
  readonly [openAuthority]: true;
  publish(ready: ReadySession): AuthorizedSession;
}

type BoundTarget =
  | { kind: 'detached' }
  | { kind: 'existing'; session: AuthorizedSession }
  | { kind: 'create'; slot: AuthorizedOpenSlot };

type Admission =
  | { kind: 'admitted'; scope: AdmittedScope }
  | { kind: 'replan'; plan: LockPlan }
  | { kind: 'need-settlement'; lifetimeId: LifetimeId }
  | { kind: 'refused'; error: AppError };

interface ProducerOutputs {
  reserve(kind: OutputKind, suggestedName?: string): OutputReservation;
}

interface OutputReservation {
  readonly sink:
    | { kind: 'file'; destination: DaemonDestination }
    | { kind: 'provider'; key: ProviderSessionKey };
  commit(): Promise<CommittedOutput>;
  discard(): Promise<void>;
}
```

Use generated lifetime IDs for journals. Pass committed output IDs and typed receipts to finalization. In CI, report the raw `sessionStore` reads outside owners on every PR and fail on an increase. Start from the [0.22 baseline](../evidence/daemon-session-authority-0.22.md). The final owner rule checks resolved imports and re-exports and removes store-shaped handler ports.

## Consequences

- A command that lacks an admitted capability cannot use a session port. A stale capability cannot act on a replacement. A stale cleanup cannot release its claim. A finalizer cannot register a response path or infer a producer.
- An RPC or SDK caller that used to attach a first lease to an open session must close it and open again. Active recording, trace, and profile work cannot span that ownership change. Same-owner reopen, same-owner capture then open, and retained close then fresh open remain available.
- Remote RPC callers that supplied host destinations must download by output ID. Clients keep local placement, script revision delivery, and recording sidecars. Remote reads of owner-unknown legacy diagnostic logs and recording exports are refused. Keep local recovery and exact-owner recorder cleanup. A committed recording can be served again if the producer proves ownership and the bytes survive. Restore output eligibility after restart only when retention was already durable and the record is verified.
- Restart begins with an empty live session store. The rental journal covers new provider allocations from reservation through confirmed release. Legacy live and pending journals still recover through the same lease end owner. Restart retains host-global device claim records. Provider runtimes without restart reconciliation leave a fenced rental for the operator. Client saved-connection records ([#4925](https://github.com/callstack/agent-device/pull/4925)) follow separately.

### Wire compatibility

For the path cutover, cover 0.22.x and the first release series with the new output contract in both client/daemon directions. Within this window, accept the supported legacy request shape without trusting its paths. Keep trace and perf destinations on the client across start and stop. Give new clients a safe mixed-version path to download. Retire peer-echoed paths and the remote placeholder exchange only after those combinations pass and the release notes state the supported window. Under [ADR 0006](0006-daemon-rpc-protocol-version.md), add `compatibleChanges` acknowledgments for compatible declaration changes. If a declaration is removed or a supported pairing cannot communicate safely, apply the protocol increment rule.

## Rejected alternatives

- Journal only live leases or release retries. A daemon can exit after a billable request and before the provider identifies its instance. The contention reservation must already be durable at that point.

- Add authorization at each store lookup. A late lookup can still choose a different lifetime.
- Let the request or sweep tear down expiry independently. They can duplicate cleanup or race the next allocation.
- Infer an output owner from the reply. Teardown and restart can outlive the request that caused publication.
- Keep a second command classification or use a state machine framework. Descriptor predicates and exhaustive tagged transitions cover the needed decisions.

## Migration order

Land this ADR first. Use PRs of about 150 production lines where practical. Keep each step runnable.

| Step | Delete | Prove |
| --- | --- | --- |
| 1. Bind authority to one lifetime. Start with script publication. | Late address rereads and in-place lease attachment. | First publication, same-owner reopen, early cross-owner refusal, and gated replay cleanup under interleaved close and reopen. |
| 2. Bind the journal to one lifetime. | Address-derived lookup for new records. | Case variants and reopen get separate journals. Refusals get detached records. |
| 3. Share the visibility rule. | Separate response name filter. | Shared-token, tenant, and local recovery cases agree across listing, progress, and contention. |
| 4. Settle expiry once. | Inline expiry, successor takeover, and early successor renewal. | Sweep and close races, wait and cancellation, hold drain, and step unwind share one settlement. |
| 5. Fence unresolved provider allocations. | Registry-forget paths for failed and late allocations. | Failed release blocks overlap. Restart resumes only provable recovery. |
| 6. Commit output at the producer. | Each converted family's response-time registration and implicit path authority. | Producer proof before and after close, path replacement safety, retention and recovery, and mixed-version delivery. |
| 7. Require the scoped ports. | Remaining raw store ports and old scope finalizer. | The owner rule rejects new raw edges in handlers and replay. The final dispatcher passes real-path gates. |

## Amendments

| ADR | Accepted change |
| --- | --- |
| [0007](0007-remote-device-leases.md) | Fix the lease at session creation. Use one expiry job per lifetime and a lease-level end reservation. |
| [0008](0008-command-descriptor-registry.md) | Keep descriptor policy as the dispatcher input. Require proof before session effects. |
| [0022](0022-daemon-platform-runtime-coupling.md) | Extend the R75 handler ratchet with counted reads outside owners and then a raw-store owner rule. |
| [0024 §2.5](0024-screen-recording-provable-signal.md#25-recovery) | Require the original producer's proof for remote export admission, including exports finished by teardown. Keep recorder recovery fenced by exact identity. |
| [0036](0036-bounded-composite-resource-admission.md) | Prove authority before resource probes. Refuse and unwind a step that would re-enter a lock or await settlement under outer locks. |
