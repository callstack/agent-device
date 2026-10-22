# ADR 0036: Bounded Composite Resource Admission

## Status

Accepted for issue #3325 operation and nested-test admission. Session lifecycle disposal and claim recovery remain for the final layer.

## Decision

For a bounded `batch` or `replay`, classify each step by the command descriptor's resource trait. `packages/daemon/src/core/composite-resource-admission.ts` owns the admission decision under the existing session and device locks. It reads existing resource owners and operation plans. A resource shape that cannot finish within the composite budget is refused before that step's lease admission, binding, cleanup, or native effect. Unknown shapes fail closed. The typed refusal names the shape and public command name while retaining completed progress and replay source.

The outer composite still authenticates, renews its lease, protects in-flight work, and reports activity. It does not refresh recording health because that read can invalidate a durable recording; an admitted step owns its own refresh. Session lifecycle steps retain their prior admission behavior in this layer. Direct commands and unbounded tests keep their existing behavior.

## Reason and alternatives

The daemon deadline bounds the composite but cannot prove that a resource operation or session teardown settles before it. The registry trait gives one complete classification for batchable and recorded actions. Rebuilding operation policy in a second command table would drift from the handlers. Deferring the refusal until dispatch would let the refused step admit a lease or change durable ownership. Reconstructing a runnable CLI command from daemon arguments would confuse structured batch inputs, replay syntax, and private CLI context. The refusal instead points to the caller's original step and session.

## Consequences

Callers inspect completed steps before retrying and run a refused shape separately with its original arguments, options, session, and private CLI context. `standaloneCommandName` is a public name, not a copy-paste command. Replay keeps the failed step, source, `repairHint`, and digest-bound resume metadata; it skips post-refusal capture. Ordinary replay failure capture and recovery remain unchanged. The final layer must add session disposal and foreign-claim recovery without weakening this step admission boundary. A cross-daemon change after preview cannot promise universal zero binding.

A bounded resource refusal inside a nested test ends that test's attempts after cleanup. It remains the reported test failure, distinct from infrastructure failure. Unrelated failures retain their configured retries.
