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

The prototype uses an internal state capsule, not an engine port. It puts ref-frame, recording,
corrective-resume, and repair transitions behind daemon-owned authority, keeps a client-supplied
plan-digest check outside session state, rejects active publication while a repair owns the session,
and calls a pure `.ad` serializer from session-owned publication. Its assertions cover invalid
transitions, ref expiry before successful and failed mutations, repair/recording disjointness,
digest validation without session mutation, and single publication; it then prints compact JSON
evidence.
