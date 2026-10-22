# ADR 0036: Bounded Composite Resource Admission

## Status

Accepted for issue #3325 operation and nested-test admission. Session lifecycle disposal and claim recovery remain for the final layer.

## Decision

For a bounded `batch` or `replay`, classify each step by the command descriptor's resource trait. `packages/daemon/src/core/composite-resource-admission.ts` owns the admission decision under the existing session and device locks. It reads existing resource owners and operation plans. A resource shape that cannot finish within the composite budget is refused before that step's lease admission, binding, cleanup, or native effect. Unknown shapes fail closed. The typed refusal names the shape and a standalone command while retaining completed progress and replay source.

The outer composite still authenticates, renews its lease, protects in-flight work, and reports activity. It does not refresh recording health because that read can invalidate a durable recording; an admitted step owns its own refresh. Session lifecycle steps retain their prior admission behavior in this layer. Direct commands and unbounded tests keep their existing behavior.

## Reason and alternatives

The daemon deadline bounds the composite but cannot prove that a resource operation or session teardown settles before it. The registry trait gives one complete classification for batchable and recorded actions. Rebuilding operation policy in a second command table would drift from the handlers. Deferring the refusal until dispatch would let the refused step admit a lease or change durable ownership.

## Consequences

Callers inspect completed steps before retrying and run a refused shape separately with its original arguments, options, and session. The refusal gives a runnable public command when the CLI can express the step safely. A secret-bearing or unrepresentable step gives a typed omission and directs the caller to its original input. The final layer must add session disposal and foreign-claim recovery without weakening this step admission boundary. A cross-daemon change after preview cannot promise universal zero binding.
