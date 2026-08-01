# Internal module interface principles

Status: proposed architecture guidance

These rules govern logical modules inside `agent-device`. They optimize for the minimum context and
authority needed to make a safe contribution, not minimum LOC or the maximum number of packages.

## Capabilities narrow authority

> State crosses boundaries as values, authority crosses as capabilities, and both only narrow.
>
> A boundary exists when its port has two implementations; otherwise it is indirection.

Authority travels as an unforgeable argument, never as ambient state:

```text
request token
  -> admitted request (lock, lease, provider scope)
  -> capability port (one session, no re-locking or session addressing)
  -> engine runtime (only the operations its port exposes)
  -> platform facet (one request-bound device)
```

An engine cannot mutate another session because its interface cannot express a session name, obtain
a store, acquire another lock, or select another provider scope. The daemon adapter closes over the
already admitted request and supplies only the capability required for that execution.

A port is earned by two real adapters: normally the daemon adapter and a deterministic in-memory
adapter used by the same contract suite. Local-substitutable dependencies such as filesystem writes
use temporary directories directly; they do not acquire a public port solely for mocking.

## Communication rules

Treat these as PR tests:

1. **Down through façades, up through ports, data as values.** Cross-module data is immutable:
   prepared plans, step requests, observations, progress events, and typed outcomes. A mutable
   object crossing the seam means the seam is fictional.
2. **Every port has two real adapters.** The production and in-memory adapters run the same
   contract. If the in-memory twin cannot implement the port without recreating daemon internals,
   the port is too broad or sits at the wrong seam.
3. **No event bus between modules.** Control flow remains explicit, call-based, and serialized.
   ADR 0018's journal is an observation channel for diagnostics, reporting, and analysis; no module
   coordinates state by subscribing to another module's events.

## Session-state consistency

Session state contains three different consistency disciplines. Do not force them through one
generic transaction mechanism.

### Immediate pessimistic transitions

Authorization and observation-lineage transitions commit synchronously before an asynchronous
device operation. Ref-frame expiry is the model: expire immediately before the possible side
effect, and retain that expiry even when dispatch times out or fails.

### Staged protocols

Repair and publication are saga-shaped protocols: arm, establish a watermark, complete, then commit
or abort while preserving operation receipts and failure tombstones. A successful non-idempotent
step commits its operation-keyed receipt before the next fallible step. Retry reuses a matching
receipt; a different operation identity executes again. Their failure handling is domain behavior
owned by the capability, not generic store rollback.

### Append-only streams

Recorded actions and journal events append facts. They are not reconstructed mutable state and do
not coordinate modules.

Collapse each mutable field cluster into one discriminated union so invalid combinations are
unrepresentable. For the script cluster:

```ts
type ScriptPublicationTarget = Readonly<{
  path: string;
  source: 'generated' | 'explicit' | 'healed-sibling';
  force: boolean;
}>;

type RepairPublicationStatus =
  | { kind: 'armed' }
  | { kind: 'complete' }
  | {
      kind: 'close-succeeded';
      completion: 'armed' | 'complete';
      receipt: { operationKey: string };
    }
  | { kind: 'committed'; path: string; receipt?: { operationKey: string } }
  | {
      kind: 'aborted';
      reason: 'explicit-close-incomplete' | 'lifecycle-incomplete' | 'teardown-commit-failed';
      receipt?: { operationKey: string };
    };

type ScriptPublicationState =
  | { kind: 'inactive' }
  | {
      kind: 'ordinary';
      target: ScriptPublicationTarget;
      status:
        | { kind: 'armed' }
        | { kind: 'published'; path: string }
        | { kind: 'aborted'; reason: 'second-open' };
    }
  | {
      kind: 'repair';
      boundary: number;
      sourcePath: string;
      target: ScriptPublicationTarget;
      watermark?: ResumeWatermark;
      status: RepairPublicationStatus;
    };
```

This makes ordinary publication and repair ownership mutually exclusive by construction. It also
keeps the publication target and its force authorization together, and makes a successful platform
close durable before atomic publication. A publication failure remains `close-succeeded`; retrying
the same operation does not repeat the close.

A Redux-like or request-transactional session store is deliberately rejected. ADR 0014 requires
ref-frame expiry to commit in the middle of a request, before awaiting the device operation, and to
survive that operation's failure. End-of-request commit or rollback would recreate the
success-only-rollback bug. Existing mechanisms already provide the useful properties: the request
lock and single-threaded runtime provide isolation, capability modules own mutations, and the event
log provides an audit trail. Actions and reducers would add a shallow indirection layer without
adding safety.

## R7 is the migration ratchet

`SESSION_STATE_FIELD_OWNERS` already assigns every `SessionState` field to its legal writers. Move
one field cluster at a time:

1. take its declared owner and pin the current invariant through the owning interface;
2. move every write behind capability transition methods;
3. collapse the nullable fields into one tagged field;
4. expose immutable `view()` projections to readers;
5. replace the cluster's R7 rows with the single new owner entry.

The shrinking field/owner table is the progress metric. `SessionStore.get()` returning a live record
becomes capability-only; ordinary readers consume snapshots from `view()`.

## Locality is operational

A logical module is one directory containing:

- one façade that presents its complete interface;
- implementation under `internal/`;
- contracts and adapters owned at its seams; and
- tests whose topology mirrors the implementation.

A contributor answering one module question should start at its façade and remain inside that
directory except for named ports and leaf contracts. The gate enforces zero imports into another
module's `internal/` tree. Tests move with their subject rather than remaining in daemon-wide family
files.

Locality is measured by:

- forbidden-import counts at zero;
- public interface size and number of permitted consumers;
- R7 field/owner rows for session state;
- the largest value-plus-type SCC (R9); and
- whether source and tests for one question fit within one bounded directory read.

Moving an engine does not improve R9 when none of its files belong to the SCC. That work continues
at the actual type hubs and concrete platform-state edges after extraction.
