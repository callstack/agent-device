# Daemon boundary prototypes

These are throwaway executable design probes, not production implementations. Their assertions make
two architecture questions concrete before changing module ownership; they are not evidence that
the production migration is complete or behaviorally equivalent.

## Program boundary

Run:

```sh
pnpm prototype:program-boundary
```

Question: can replay-test orchestration run both `.ad` and Maestro files through one small
program-level API without creating a shared replay VM?

The prototype keeps the native replay and Maestro interpreters independent. Each adapter privately
binds its engine to a different runtime port. The test scheduler sees only `inspect` and `execute`;
this is the scheduler seam, not the native engine façade, which the proposal shapes as `prepare`
plus `execute` over one opaque prepared plan. It executes passing and failing examples for both
formats, asserts the independent runtime traces, and prints compact JSON evidence.

## Session aggregate

Run:

```sh
pnpm prototype:session-boundary
```

Question: can a daemon-owned coordinator keep replay from receiving any mutable `SessionState`
interface, while plan-digest validation remains engine-owned and publication remains session-owned?

The prototype uses one internal tagged script aggregate, not an engine port or parallel replay and
publication state. Separate `ReplaySessionTransaction` and `SessionScriptPublication` capability
projections mutate that same aggregate. The repair scenario carries one instance through arm,
corrective-resume watermark, recorded correction, completion, successful platform-close receipt,
failed publication, retry, and commit.

Its assertions pin the transaction edges called out by the production close path: platform-close
failure leaves the whole aggregate unchanged; publication failure retains target/force and an
operation-keyed close receipt; retrying the same close does not dispatch it twice; changing the
close identity does; retargeting without live force drops the old target's authorization; and
terminal committed or aborted state is explicit. The aggregate probe also covers ref expiry before
successful and failed mutations, repair/recording disjointness, digest validation without session
mutation, and single active publication, then prints compact JSON evidence.
