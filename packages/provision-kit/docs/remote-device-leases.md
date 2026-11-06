# Provider lease table

The Revyl provider runtime serves allocation, release, expired-lease recovery, and shutdown from a shared lease table, `@agent-device/provision-kit/provider-lease-table`.
The provider supplies its start timeout, an optional stop timeout, start, stop, find-by-lease, a key that identifies a rental, and the errors that it reports.
The table owns the rules that decide whether a billed device is still rented:

- One lease id has at most one start. Overlapping allocations join it, and a ready session is reused.
- Each caller waits until the earlier of its own deadline and the start timeout. A caller whose budget is already spent sends no start. A caller that gives up stops nothing. The start runs while any caller still waits, for at most the start timeout: no single caller's signal or deadline reaches it, and the table tells the provider to abandon it once no caller waits or the lease starts ending. A ready device goes to the callers still waiting within their budgets, and it is stopped when no caller waits. Each caller's budget is checked when the session is handed over, on reuse as well.
- A start can publish its rental before it answers. A teardown waits for the answer for at most the start timeout, then stops the published rental and keeps the lease pending until the answer arrives.
- Release, recovery, a failed start, and shutdown each end a lease through one teardown that all of them join. The teardown fences the lease in the same step: from then on, an allocation of the lease is refused, including an allocation that was already waiting, and the device inventory and interactor no longer serve the lease. Revyl reports a refusal for a lease that a release, a recovery, or a failed start is ending as `provider-lease-releasing`, and a refusal after shutdown began as `runtime-shutting-down`.
- A teardown forgets a lease only after the provider confirmed the stop of every rental that it knows. It stops them one at a time, in the order they were named, and a rental named while a teardown settles gets a teardown of its own. A failed or late stop keeps the lease for the next teardown, which joins the stop still in flight. Shutdown is a fence: from then on, an allocation, or a recovery of a lease that has no entry, is refused with `runtime-shutting-down`, and a release only joins an entry that already exists, so one drain pass ends every entry. It reports what stays rented with `provider-cleanup-pending`.
- If a start fails without an answer, or a recovery finds no entry, the teardown asks find-by-lease. If the provider cannot name the rental, the lease stays pending, and the next teardown asks again.

The Revyl runtime-owner instance is the shared 32-byte digest. Revyl keeps it in process memory and never persists or sends it.
