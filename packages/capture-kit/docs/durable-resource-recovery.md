# Durable resource recovery contracts

A durable start returns a process-local live handle and a bounded, JSON-safe, versioned descriptor sufficient for deterministic recovery by the exact owner.
The facet-specific handle provides idempotent `finish()` returning `FinishOutcome`, `forceCleanup()` returning `CleanupOutcome`, and an idempotent `[Symbol.asyncDispose]` adapter that carries no typed result.
The adapter resolves only for confirmed cleanup or already-missing outcomes.
Otherwise, it rejects with a normalized `ownership-lost` or `cleanup-pending` error.

Each destructive finish or cleanup holds the authoritative ownership lease across fence validation, native side effect, and persisted transition, or uses a token atomically enforced by the native or provider operation.
A preflight check alone is insufficient.
A transport without either mechanism cannot claim transferable reattachment; cleanup-only recovery needs proof that the prior owner is gone, or remains manual.

A partial start rolls back internally if it cannot publish a complete pair.
The request scope guards the start promise and registers the handle for forced cleanup before orchestration receives it.
The coordinator persists the authoritative active record, transfers the pending guard, and then adopts the handle into live session state.
On failure before transfer, rollback disposes the pending handle; after transfer, it disposes the transferred handle.
The record becomes terminal only after confirmed cleanup; uncertainty remains cleanup-pending.
Contract scenarios inject failure and cancellation between partial start, publication, persistence, adoption, and transfer.

There is no generic platform resource.
Live session state may hold a neutral facet-specific handle beside its descriptor and metadata under one R7 transition owner.
Only the descriptor and neutral metadata enter persisted recovery state.
Neither store contains concrete platform classes, provider clients, child handles, timers, transports, or wait promises.
The capture-kit durable-capture coordinator, which the daemon composes, owns persistence, adoption, compensation, fencing, and exact-owner recovery.
It owns bounded manifest I/O, per-resource fence serialization, start/persist/adopt compensation, terminal transitions, and deadline-bounded exact-owner recovery.
It receives the kind, manifest store, neutral session slot, completion projection, failure wording, and exact-owner adapter.
It selects no platform, interprets no flags, and is not a generic runtime facet.
App-log and recording retain distinct handles, descriptors, facts, native finalization, and admission policy; capture-kit owns reusable lower-level codec and live-handle mechanics.

A process-lived admission ledger may hold bounded cleanup uncertainty without an honest durable representation, but no handle or descriptor, and never supersedes the manifest.
The daemon app-log admission ledger revalidates retained legacy marker paths for the matching device on admission; after manual recovery removes a marker, the next check can unblock that device without restart.
A marker without device identity stays on disk as path-local no-overwrite evidence and does not block every device.
The shared ledger keys undurable cleanup blocks by device, clears them after confirmed cleanup, and expires them under a bounded policy with diagnostics.

Persisted JSON enters as `unknown`.
Contracts validate the neutral kind/version, session/device identity, exact owner, fence, and lifecycle envelope before the selected facet's total codec decodes its body.
Invalid or unknown data remains recovery evidence with typed `descriptor-invalid` or `descriptor-version-unsupported` outcomes; it is never cast, deleted, or offered to another facet.
If no live handle is available, after lease/admission and takeover fences, recovery binds the exact owner and calls typed `reattach`.
Its closed outcomes are `active` with handle, `completed` with result, `missing`, and `unreattachable` with typed reason.
Reasons include `descriptor-version-unsupported`, `owner-unavailable`, `transport-not-reattachable`, and `ownership-fence-lost`.
Recovery never guesses a migration, discards the descriptor, tries another owner, or starts a replacement.
A descriptor may explicitly declare cleanup-only recovery when equivalent live control cannot be reconstructed; this is a runtime fact.

Reattachment does not reconstruct session state or change `SESSION_NOT_FOUND` policy.
Without an admitted live session, the recovery scope owns the handle and may only complete or clean up; continued use requires an independently admitted live session.
Each durable facet also supplies typed idempotent descriptor-only cleanup with cleaned, already-missing, or cleanup-pending outcomes.
Cleanup-only recovery uses this operation without reconstructing a full handle.
Finish, disposal, and cleanup share the serialized or atomically enforced fence.
If owner or schema is unavailable, cleanup cannot be inferred and the record remains cleanup-pending with a manual-recovery reason.

Before start reports success, the descriptor must have an authoritative persisted home with deterministic facet-owned lookup or enumeration after process loss.
Prefer an existing resource-owned manifest; introduce a daemon record only for demonstrated need and a shared index only when multiple kinds justify it.
Events and the proposed journal are observability only, never recovery authority.
The neutral record holds session/device identity, exact owner, descriptor and metadata, fence, and `open` or `completed` lifecycle state.
Starting, active, completing, and cleanup-pending are phase metadata on the open record, not additional lifecycle states, so cleanup uncertainty cannot be encoded as a terminal lifecycle.
The fence and descriptor remain authoritative throughout open phases.
A new handle stays private until it acquires the persisted fence.

Persistence cannot make external start and descriptor write atomic; a platform retains an orphan marker or equivalent protocol when its native tool cannot close that crash interval.
Descriptors hold stable reconstruction coordinates, not promises, timers, child handles, buffers, credentials, or live-state dumps.
Transfer is explicit: persist active evidence before success, transfer the pending guard before session adoption, dispose it on failed adoption, and preserve the terminal result or stable coordinates before removing active evidence.
Adopted handles survive request disposal and remain outside the binding's generic disposable transaction; normal session teardown keeps facet-specific order.
