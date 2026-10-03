# ADR 0020: Composable Recorded Fragments

## Status

Proposed design spike for [#1336](https://github.com/callstack/agent-device/issues/1336). This
ADR settles the artifact and ownership contract; implementation is intentionally a later,
separately reviewable sequence.

## Context

The E3 repair-economics matrix measured re-recording as cheaper than agent repair for label drift
($1.21 versus a $2.34 repair median) and cascade drift ($1.55 versus $2.05); repair won only for a
single diverged read ($0.69). That single-read figure is a repair-only baseline; the re-record
comparison is the label/cascade rows. Re-recording is therefore the repair path, and the useful lever
is the unit being re-recorded. If thirty flows share a login journey, the reusable unit should be one
fragment, not thirty closed scripts.

Today a native `.ad` recording is a closed unit: its `open` establishes the session and its `close`
tears it down. ADR 0016 deliberately stopped at open-to-destination publication and left arbitrary
slices for this decision because target evidence is captured at action time, not reconstructed from
history. ADR 0012 also makes the cost of losing composition provenance concrete: a Maestro include
that was flattened into one plan shifted step ordinals and made divergence attribution and the
include's line table ambiguous. ADR 0015 now requires Maestro to remain a source-preserving typed
interpreter that owns `runFlow`, scopes, conditions, repeats, retries, and include loading.

The design must consequently solve four boundaries together: a fragment cannot hide session
lifecycle, the first action must prove the entry screen, a fragment edit must invalidate exactly the
compositions that use it, and a failure must name a local step and invocation rather than an
expanded global ordinal.

## Rules at a glance

1. **A native recorded fragment is a lifecycle-free body.** Its composing flow owns `open`,
   context, launch state, session ownership, and `close`. A native fragment has no `open` or
   `close`, and invoking it never relaunches or tears down the session. Maestro subflows retain
   their typed-flow lifecycle semantics under ADR 0015.
2. **Native capture is explicit and entry-guarded.** `session fragment start <path> --entry
   <selector>` captures a verified landmark as the first recorded `wait`; `session fragment save`
   publishes the body without closing the session. Post-hoc history slicing is not a supported
   native capture path.
3. **Composition is one semantic model, not one engine.** Native `.ad` `include` and Maestro
   `runFlow` produce the same invocation boundaries, provenance records, address construction, and
   structured failure projection. Format-owned parsers and interpreters retain identity, digest,
   lifecycle, and execution semantics; neither lowers the other into a second replay engine.
4. **Native references are digest-pinned.** A persisted native `.ad` include carries a relative
   locator and the expected content digest of the fragment it resolved when authored. A missing,
   changed, cyclic, or unsupported native fragment fails preflight before any device action. Maestro
   `runFlow` keeps its ADR 0015 source-preserving loader and existing compiled-plan digest; it does
   not adopt the native comment syntax. There is no implicit "latest" fallback or silent repinning
   for native artifacts.
5. **Addresses are owner-local.** A composed step is addressed by its fragment digest or root
   composition digest, invocation/control paths, and local step ordinal. `source.path:line` remains
   diagnostic provenance. A global `displayOrdinal` may be retained as bounded display data, but
   never authorizes resume or appears inside the address.
6. **Existing target evidence remains the contract.** The entry guard and element actions reuse
   ADR 0012's `target-v1`/`targets-v1` annotations and verification. Every v1 native fragment and
   composed parent starts with a required first-executable format guard (`fragment-v1` or
   `composition-v1`). A new reader consumes that guard during preflight; an old reader treats it as
   an unknown action and rejects it before dispatch, so it cannot execute a root `open` or a known
   prefix before reaching `include`. Other fragment metadata and references remain reserved
   comments, so old readers ignore those annotations rather than silently flattening composition.
7. **Native fragment repair is explicit re-recording.** Native `.ad` `replay --save-script` does
   not flatten a composed plan into a monolithic healed script. Until fragment-specific repair is
   implemented, the caller re-records the affected fragment and explicitly repins its callers;
   Maestro retains its existing unsupported-`--save-script` behavior.

## Decision

### Fragment artifact and lifecycle ownership

A v1 fragment is a portable `.ad` body with a required first-executable format guard and no session
lifecycle. Its shape is conceptually:

```text
fragment-v1
context platform=ios target=mobile
# agent-device:target-v1 {"id":"home","role":"heading","label":"Home","ancestry":[],"sibling":0,"viewportOrder":0,"verification":"verified"}
wait "id=\"home\""
click "label=\"Continue\""
```

The exact writer surface belongs to the future implementation, but these invariants are fixed:

- `fragment-v1` is the required first-executable format guard. The new reader consumes it during
  source preflight; it is a format envelope, not a `SessionAction` and has no device side effect.
  A composed native parent uses the corresponding `composition-v1` guard as its first executable
  line, before root `open` or any `include`. An old reader parses either guard as an unknown action;
  the existing `dispatchKnownCommand` seam rejects it with `INVALID_ARGS` before invoking any
  platform handler. The fragment has no `open`, `close`, or hidden launch action. The writer always
  emits the effective `context platform` and `target`, and a parser rejects a fragment missing
  either constraint. Those values constrain the effective platform/target but do not select a
  device or establish a session; the parent supplies those facts.
- The first executable step is an identity-bearing selector `wait` with `target-v1` evidence whose
  `verification` is `verified`. It is the fragment's entry guard and is included in the fragment
  digest. The guard uses the existing landmark-mode polling and identity semantics; it is not a
  screenshot fingerprint or a best-effort label check. Its timeout is the exact existing `wait`
  positional budget. `start` accepts an optional entry-timeout; when omitted, capture resolves the
  current selector-runtime default once and writes that concrete millisecond value into the guard.
  Published fragments therefore never depend on a future runtime default, and changing the default
  does not invalidate existing digests.
- The body uses the existing recorded-action codec, selector-chain optimization, target evidence,
  and ADR 0017 parameterization rules. It does not introduce a second annotation format or a
  fragment-specific target matcher.
- Fragment admission is decided from the command descriptors and recording traits. Session
  lifecycle, device ownership, recording publication, and other resource-owning commands are not
  admitted by duplicating a hand-maintained command-name list in the fragment writer. Admission is
  an allowlist over a positive fragment-safe descriptor trait; a command without that declaration is
  refused before arming or replay, so a future command cannot become fragment-safe by omission.
  During an armed capture, such a command is refused before dispatch and the capture remains armed
  and retryable; during replay, the complete plan is rejected in preflight. The implementation must
  classify every currently supported recording command before enabling the new surface.
- A fragment invocation inherits the parent's effective session, context, and late-bound native
  `${VAR}` scope. Preflight enumerates the fragment's referenced names and refuses an unbound name
  with `fragment_variable_unbound` without expanding its value into the digest. V1 has no
  per-invocation argument or output-variable contract: names resolve in the inherited flat scope,
  with no fragment-local shadowing. Callers provide values through the existing script/header/shell
  mechanisms. Maestro's scoped environment and output semantics remain those of its typed `runFlow`
  interpreter under ADR 0015.

The **session** owns the live device and app. A separate **fragment capture aggregate** owns the
capture buffer, entry guard, target path, and `ARMED`/`PUBLISHED`/`ABORTED` publication state. It
does not become a second session lifecycle and it does not append a synthetic `close`. The ordinary
session action log continues to accumulate beside the fragment buffer; the fragment capture is
mutually exclusive only with an ordinary script-publication transaction and an ADR 0012 repair
transaction, because overlapping publications would make ownership and provenance ambiguous. The
fragment body
cannot contain lifecycle `open` or `close`; a new session/open request or ordinary recording/repair
transaction is refused before platform dispatch while capture is armed with `fragment_capture_conflict`
and `{sessionState: "fragment_armed", conflictingOperation}` details. A session-ending `close`
instead aborts the armed capture without publishing a file, then performs the ordinary close and
device-claim release. Client disconnect or lease expiry aborts the capture as well. `save` and an
explicit `abort` leave the underlying session active.

The session action log is retained for diagnostics and ordinary command history, but a session that
has armed or published a fragment is not eligible for ordinary open-to-destination publication: a
later ordinary publication request returns `fragment_capture_conflict` and tells the caller to start
a fresh session. This prevents the same journey from being silently emitted once as a fragment and
again as an unmarked closed script.

### Recording UX: start at the boundary, never slice after the fact

The v1 authoring workflow is an explicit in-session boundary:

```sh
agent-device session fragment start ./fragments/login.ad --entry 'id="Home"'
# perform the reusable login journey with ordinary commands
agent-device session fragment save
```

`--entry` is a portable selector expression, not a session-local `@ref`. Starting the capture
resolves it against the current observation and records the equivalent selector `wait` plus fresh
`target-v1` evidence as local step 1. Start refuses before arming when the selector is absent,
ambiguous, identity-empty, or otherwise cannot produce verified landmark evidence. This makes the
entry precondition explicit while still making the guard automatic in the artifact. A caller may
abort and retry at the same live session; it cannot ask the writer to infer a screen identity from a
snapshot or from a history range.

`session fragment save` uses the target path fixed by `start`, with the existing same-directory
atomic publication and no-clobber default from the script writer. There is no alternate save
path that could disagree with the armed aggregate; changing the destination requires aborting and
starting again. A target collision, serialization failure, or invalid fragment body leaves the
capture armed and retryable; a successful save is the only transition to `PUBLISHED`. `--force` is
an explicit replacement authorization. Publishing a new body at the old path intentionally makes
callers holding the old digest stale, so versioned paths are recommended for shared fragments. An
interrupted or aborted capture publishes no partial fragment.

This is deliberately not a post-hoc slice of `session.actions`. ADR 0012's target evidence is
computed from the tree at resolution time and cannot be reconstructed reliably after the session has
moved. Existing active-session publication therefore remains an open-to-destination artifact, while
fragment capture has its own explicit boundary and first-step guard.

### One composition model below two interpreters

The future implementation introduces a small shared **composition/provenance model**, not a shared
replay VM. Its records are semantic data used by both engines:

```text
CompositionPlan
  root plan metadata
  root actions and control nodes
  fragment invocations
    fragment identity (format + content digest)
    include call-site and inherited scope
    invocation path / loop iteration
    child actions or typed control nodes
```

The model owns only the cross-cutting facts that must agree:

- fragment identity and the digest dependency graph;
- invocation boundaries, lifecycle ownership, and inherited scope identity;
- `FragmentStepAddress` construction and source provenance;
- preflight errors for missing, stale, cyclic, or unsupported fragments; and
- the structured failure projection that carries the local address.

The model does **not** own selector matching, platform dispatch, Maestro conditions, repeat/retry
polling, or native `.ad` parsing. Native `.ad` parsing recognizes an `include` control and builds a
nested invocation node. Maestro keeps `runFlow` in its source-preserving typed IR and interpreter;
the interpreter contributes the same invocation/provenance records when it loads a child program.
Maestro's `runFlow` controls, scoped variables, optional behavior, and runtime repeats remain
Maestro-owned as required by ADR 0015. The shared model prevents a second semantic implementation;
it does not move `runFlow` out of that interpreter.

A composed native parent has a required `composition-v1` first-executable guard before its root
`open` or any `include`. A flat native `.ad` script without an include keeps the existing artifact
shape and behavior. The guard is consumed by the new source preflight and is not a device action;
its purpose is to make an old reader fail at the format boundary rather than partially execute a
new composed artifact.

V1 does not allow cross-format includes: native `.ad` `include` loads a native fragment, while
Maestro `runFlow` loads Maestro programs. They share the composition contract, not a coercion path
that would make either parser interpret the other's syntax.

The pinning surface is format-specific. A native persisted include must carry the
`fragment-ref-v1` expected digest. A file-backed Maestro `runFlow` contributes the child source
closure and its existing compiled replay-plan digest to the shared identity/provenance records; a
caller that supplies an expected Maestro plan or composition digest gets the same preflight stale
failure when the loaded closure changed. With no expected Maestro digest, ADR 0015's existing
behavior intentionally loads the current source closure and produces its new plan identity. This
does not authorize native `.ad` to float to a newer file. An inline Maestro `runFlow: commands:`
body remains a typed control node rather than a file-backed fragment in v1, so it has no fragment
locator or standalone fragment address. A skipped conditional invocation creates no child
invocation or iteration ordinal; ordinals are assigned only to executed iterations.

The native entry-guard, lifecycle-admission, and lifecycle-free artifact rules apply only to the
recorded `.ad` fragment format. Maestro subflows retain their existing typed-flow preconditions and
may contain Maestro-owned lifecycle or control commands; the shared model records their boundaries
and provenance without coercing them into a native fragment body.

Maestro supplies the shared identities from its typed IR rather than from new YAML fields. A
`runFlow` call-site ID is a format-tagged digest of the canonical typed node, its resolved
source-bundle-relative locator, and its local occurrence among otherwise identical sibling nodes;
`repeat`/`retry` control IDs use the same rule. Source lines and expanded plan ordinals are excluded.
These IDs are internal to the compiled plan, not author-facing syntax; changing the node or its
local structure changes the existing Maestro plan digest and invalidates old addresses. The local
occurrence discriminator only distinguishes identical authored siblings within one plan and is not
used as a global step identity. Maestro addresses are stable only within their matching compiled
plan digest; a source edit, including an earlier identical sibling, intentionally invalidates the
old address rather than promising cross-edit call-site stability.

An include is a control boundary, not a `SessionAction`. Its child actions are recorded and executed
inside the parent's live session, but the boundary remains visible to planning, tracing, failure
reporting, and digest construction. Nested fragments are allowed subject to cycle detection and a
bounded source/depth policy shared with Maestro's existing source-bundle limits.

### Pinned references, fragment digests, and staleness

The native representation uses a reserved reference comment immediately before its include control:

```text
# agent-device:fragment-ref-v1 {"callSiteId":"login-entry","digest":"sha256:<64 lowercase hex>"}
include "./fragments/login.ad"
```

The include path is resolved relative to the including source by the caller-side source bundle. The
`callSiteId` is the persisted identity of this authored include occurrence; the writer preserves it
when the node is edited in place and assigns a new value to a new occurrence. It is required and
unique within its parent; duplicate or missing values fail preflight with
`fragment_call_site_invalid`. The digest is the fragment identity; the path is only a locator and
source-provenance hint. A future implementation may choose an equivalent inline spelling, but it
must preserve the call-site identity, locator, and digest and must not accept an unpinned native
include in a persisted composed plan.

`fragmentDigest` is SHA-256 over canonical JSON for the parsed fragment IR, including:

- the fragment format/canonicalization version;
- effective platform/target constraints;
- the verified entry guard;
- every executable action's normalized command, inputs, execution-affecting flags/runtime hints,
  and `target-v1`/`targets-v1` evidence; and
- every nested pinned fragment reference, its `callSiteId`, and its child digest.

For a native parent, the authored relative locator of each nested include is part of that parent
reference IR, while the absolute resolved filesystem path is excluded. A child move therefore keeps
the child digest but requires an explicit parent locator edit and parent repin.

It excludes session timestamps, device names, absolute source paths, and ordinary comments. Native
`${VAR}` placeholders remain unresolved in the digest, matching ADR 0012's late-bound-value rule;
Maestro's effective static environment and parse-time expansion continue to participate in the
Maestro plan digest under ADR 0015. A changed target annotation changes the digest because the
annotation changes execution-time verification, not because it is diagnostic text.

The shared identity is `(format, digest)`, not a promise that native and Maestro source languages
produce the same hash. Each format keeps its existing canonical JSON implementation and carries its
canonicalization version in the identity input; the shared model compares the typed identity and
dependency edges, while format-owned parsers define the bytes being canonicalized.

`compositionDigest` is SHA-256 over the canonical root plan plus the ordered include call-site
semantics and the transitive graph of **pinned expected** fragment identities. It is not a hash of
every file in the caller's directory or source bundle. A valid composition digest is computed only
after the complete closure has been resolved and every expected digest has matched the bytes that
will execute. Consequently, editing a leaf changes its digest and immediately invalidates its
direct callers, but it does not mutate an ancestor fragment's own digest until that ancestor's pin is
explicitly updated. Repinning the parent then changes its digest and invalidates the next caller, so
the bottom-up walk is intentionally N levels. An unrelated fragment does not invalidate callers that
do not reference it. Moving an unchanged child requires an explicit locator update in its parent;
the child's content identity does not change. Because `callSiteId` participates in the canonical
fragment IR, renaming one intentionally changes that fragment's digest and triggers the same explicit
bottom-up repin as changing an execution-affecting action.

The complete source closure is resolved and digest-checked before step 1. The resolver returns the
verified bytes, and parsing, digesting, and execution all consume those same bytes; a second
filesystem lookup cannot replace the checked artifact. These cases fail closed without device or
session side effects:

- the pinned file is missing from the caller's source bundle;
- the actual canonical digest differs from the expected digest;
- the fragment format or canonicalization version is unsupported;
- an include cycle or source/depth/size bound is exceeded;
- the fragment violates lifecycle or entry-guard admission;
- its platform or target constraints are incompatible with the parent's effective context; or
- a referenced native variable is absent from the inherited scope.

Source-closure preflight uses the existing `INVALID_ARGS` family for caller-side input/source
validation under ADR 0010. Its machine reason is one of `fragment_missing`, `fragment_unsupported`,
`fragment_bounds`, `fragment_cycle`, `fragment_call_site_invalid`, `fragment_control_identity_invalid`,
`fragment_stale`, `fragment_lifecycle`, `fragment_entry_guard`, `fragment_context_mismatch`, or
`fragment_variable_unbound`; its details include the including source, locator, expected digest,
actual digest when available, and call-site. Agents branch on `details.reason`, never on message
text. It never silently loads the newest file, rewrites the parent, or executes a valid prefix before
discovering a stale child. `--update` remains ADR 0012's no-write suggestion surface and cannot
repin a fragment.

Request-state and artifact-kind validation also uses `INVALID_ARGS`, but has a separate details
contract and is not a source-closure error. Its reasons are `fragment_resume_mismatch`,
`fragment_resume_unsupported`, `fragment_composition_required`, `fragment_capture_conflict`, and
`fragment_repair_unsupported`. These details name the command/session state or expected/current
composition identity rather than pretending that source locator and digest fields exist: resume
errors carry expected/current composition identity, composition-required carries artifact kind/source,
capture conflict carries session state/conflicting operation, and repair refusal carries command and
format. The capture conflict is a same-session transaction-state refusal, not `DEVICE_IN_USE`, which
remains reserved for a device claimed by another session.

Source-closure preflight reports the first applicable reason in this total order: missing source,
unsupported format/version, source bound, depth bound, size bound, include cycle, missing/duplicate
call-site identity, missing/duplicate control identity, stale digest, lifecycle violation, missing
entry guard, entry-guard evidence mismatch, context mismatch, then unbound variable. A stale child
therefore wins before a composition digest can be computed; a resume supplied against that failed
closure reports the child `fragment_stale`, not `fragment_resume_mismatch`. Only after a valid
composition digest exists are request-level checks applied: a mismatched expected composition digest
is `fragment_resume_mismatch`, and an unsupported resume shape is `fragment_resume_unsupported`.
A fragment opened without a composing parent is `fragment_composition_required` and is outside
source-closure ordering.

### Stable addressing, divergence, and resume

Every executable step inside a fragment receives a local address. The conceptual wire shape is:

```json
{
  "address": {
    "version": 1,
    "owner": {"kind":"fragment","format":"ad","fragmentDigest":"sha256:<64 lowercase hex>"},
    "invocationPath": [
      {"callSiteId":"login-entry","iteration":0},
      {"callSiteId":"auth-step","iteration":0}
    ],
    "controlPath": [
      {"controlId":"submit-retry","iteration":1}
    ],
    "localStep": 3
  },
  "provenance": {
    "invocationSources": [
      {"path":"flows/main.ad","line":12},
      {"path":"fragments/auth.ad","line":7}
    ],
    "stepSource": {"path":"fragments/auth.ad","line":10}
  }
}
```

`localStep` is the 1-based logical executable step within the owner fragment, including its entry
guard. An invocation path is made from persisted include `callSiteId` values and explicit runtime
invocation ordinals; source path/line is diagnostic provenance only. `controlPath` adds persisted
typed-control identities and runtime iteration/attempt ordinals for repeat, retry, and other
format-owned controls. Every addressable repeat/retry node must provide a `controlId` unique within
its owner; a missing or duplicate identity fails with `fragment_control_identity_invalid`. The path
distinguishes repeated executions of the same logical local step and is empty for a native fragment
without such controls. Neither path is a position in the fully expanded global action array. Two
invocations of the same fragment therefore share its digest but have distinct invocation paths.
Inserting an earlier fragment does not renumber a later fragment's local steps or change its authored
call-site identity. Editing the fragment changes its digest and intentionally invalidates old
addresses.

A composed root also has addresses: its owner is `{kind: "root", format, compositionDigest}`, its
`invocationPath` is empty, and `localStep` is the 1-based logical root step. A root address is
invalidated by any composition-digest change, while a fragment address is invalidated by its
fragment or enclosing composition identity.

Only `address.version`, `owner`, `invocationPath.callSiteId`, `invocationPath.iteration`,
`controlPath.controlId`, `controlPath.iteration`, and `localStep` participate in address equality or
resume authorization. `provenance` is a sibling display/diagnostic field and is never compared for
authorization; a source comment or formatting edit can change its line without changing an
otherwise valid address in the same published composition.

Runtime iteration and attempt values are execution evidence, not a second source of identity. They
are emitted for divergence and tracing, but v1 address-aware resume accepts only an invocation and
control path whose iteration/attempt values are all `0` and whose controls are statically reachable.
A nonzero or runtime-conditional path is refused with `fragment_resume_unsupported`; the matching
composition digest cannot by itself reconstruct which dynamic iterations occurred.

The existing flat `.ad` contract remains unchanged for scripts with no composition: its numeric
`step.index`, `--from N`, and `--plan-digest` continue to work as specified by ADR 0012. A composed
native `.ad` composed plan adds `step.address` and `resume.address` for root and fragment steps and
requires a matching `compositionDigest` for any address-aware resume. A `displayOrdinal` can be
included as bounded display/progress data, but it never authorizes resume or appears inside an
address. The future native CLI/Node/MCP surface may encode an address behind the existing `--from`
option or an additive opaque resume token; it must not make callers guess which flattened ordinal
identifies a repeated fragment. A numeric `--from` supplied to a native composed plan is rejected
until the address-aware path is available.

Maestro keeps its existing format-owned numeric `from` plus `planDigest` resume contract while the
shared address fields are added in its typed-interpreter slice; this ADR does not remove that working
surface. Maestro YAML continues to reject `--save-script` with its existing format error, because
ADR 0012 repair recording applies only to native `.ad` scripts. The native address and repair rules
are not retroactively applied to Maestro.

V1 address-aware resume is legal for a composed root step and for a fragment invocation boundary
(`localStep: 1`) only. Fragment addresses for later local steps remain required for traces,
progress, and divergence, but resuming there is refused with `fragment_resume_unsupported`: the
entry guard is an entry-only precondition, not a screen invariant, and rerunning it after earlier
fragment actions would be incorrect. A future ADR may add per-step preconditions or a safe replay
prefix; v1 does not pretend that a local address alone proves the device state for a mid-body
resume. At a nested fragment boundary, only the target fragment's local-step-1 guard executes;
ancestor invocation steps and ancestor guards are not replayed, because the caller owns the skipped
parent state. Local step 1 is counted once for the target invocation.

Root-step resume retains the existing flat `--from` responsibility: the caller supplies the session
state for skipped root actions, and the matching composition digest proves only that the plan is the
same. Root steps have no fragment entry guard, so this is compatibility with the established flat
resume contract, not a claim that a root local address proves the device state.

A target-binding or action failure inside a fragment keeps ADR 0012's `REPLAY_DIVERGENCE` code,
bounded screen, repair hint, and structured cause. Its step provenance additionally names the
fragment digest, invocation path, control path, local step, and source path/line. A failure while loading or
validating an include names the include call-site instead and occurs during preflight. No error
projection is allowed to collapse a fragment failure to a parent global ordinal.

### Annotation compatibility and versioning

`fragment-v1` and `composition-v1` are reserved first-executable format guards, not comment forms or
target annotations. `# agent-device:fragment-ref-v1` remains a reserved reference comment, and the
first entry `wait` plus every element-targeting action continue to carry the existing
`target-v1`/`targets-v1` evidence, including its size limits, canonical field order, and fail-closed
`verification` behavior. Readers that do not know the reference annotation ignore that comment;
readers that do not know the executable guard reject the artifact at its format boundary.

The new reader consumes the native guard during source preflight. An old reader given either a v1
fragment or a composed parent parses the guard as an ordinary action, then the existing
`dispatchKnownCommand` rejection in `src/core/dispatch.ts` throws `INVALID_ARGS` before the
platform handler is invoked. It therefore cannot execute a root `open`, a known prefix, or an
expanded child body. An old reader given an unguarded legacy `.ad` retains its existing behavior,
including the possibility of executing a known prefix before a later unknown command; that legacy
case is explicitly outside the v1 composed-artifact acceptance contract and is not safety evidence.
The new reader rejects a fragment supplied as a top-level replay artifact with
`fragment_composition_required`. Unknown future reference comments remain ordinary comments to an
older reader, while an unknown future executable guard fails before device work.

The old-reader evidence points to the actual unknown-command seam in `src/core/dispatch.ts`; the
current `src/core/__tests__/dispatch-keyboard.test.ts` does not prove this contract. The fragment
codec implementation must add planted-red tests that run a guarded composition with `open` through
the old dispatch path, assert the guard fails before the handler, and separately preserve the
legacy-prefix fixture as out of scope. It must also add strict reserved-header/reference parsing
tests; this ADR does not pretend those tests exist yet.

Format-version changes, digest canonicalization changes, and address-shape changes are breaking
composition boundaries. A reader must not reinterpret a v1 digest under a new canonicalizer. A
minor additive annotation that preserves the v1 execution contract may remain an ignored comment,
following ADR 0012's old-reader rule, but any change to lifecycle, entry verification, or digest
meaning requires a new version and an explicit migration. The first-executable fragment or
composition guard version gates the body grammar, the reference version gates the pinned-reference
schema, the address version gates the wire address, and the canonicalization version is part of the
digest input; a mismatch in any one is a preflight `fragment_unsupported` error.

### Repair and migration boundaries

The following are intentionally not part of this spike's implementation:

- automatic extraction of fragments from an existing `.ad` or from arbitrary session history;
- fragment parameters, output variables, or a registry/content-addressed remote store;
- cross-format native/Maestro includes;
- silent repinning, auto-versioned output names, or `--update` writes; and
- fragment-aware `replay --save-script` healing.

Existing closed `.ad` scripts and ADR 0016 open-to-destination scripts remain byte/behavior
compatible. A user migrates by starting a fresh fragment capture at the desired boundary, choosing a
stable entry selector, publishing it under a new path, and adding a digest-pinned include to a
parent. No existing script is rewritten or inferred to be a fragment. Ordinary recording and ADR
0012 repair remain separate capture lifecycles; they refuse to overlap a fragment capture rather
than producing a hybrid artifact.

If a composed replay diverges inside a fragment, the agent receives the fragment-local address and
must either repair application state or re-record that fragment explicitly, then update the parent's
pin. A future fragment-repair ADR may reuse ADR 0012's agent-supervised "heal-by-doing" mechanics,
but it must publish a fragment body with a guard and preserve its digest boundary; it may not
flatten a composition as an accidental fallback. Native `.ad` `replay --save-script` on a composed
plan is refused with `fragment_repair_unsupported` until that fragment-specific contract exists; it
never silently writes a root-only script or a flattened replacement.

Nested digest changes are repinned explicitly from the changed leaf upward. The author publishes
the new child, updates each direct include and republishes that parent, then repeats for its direct
callers until the root is current. Each step is a deliberate file edit or future dedicated tooling
operation; no replay command writes pins, and preflight reports the dependency chain so the author
can see the remaining stale ancestors. This is the intentional v1 tradeoff for keeping stale reuse
visible instead of changing multiple flows implicitly.

## Consequences

- A shared login or navigation journey becomes one independently reviewable, re-recordable artifact
  while the parent retains ownership of session setup and teardown.
- Entry guards add one bounded wait and one identity capture at authoring time, but prevent a reused
  fragment from silently acting on the wrong screen.
- A fragment edit intentionally creates explicit, actionable staleness for every pinned caller.
  This adds repinning work, but avoids silently changing thirty flows at once.
- Because v1 has no fragment arguments or output variables and inherits one flat parent scope, one
  flow cannot invoke the same fragment with two independent variable sets. Callers needing that
  isolation must use separate parent scopes or separately authored fragments until a parameter
  contract is accepted.
- The required captured platform and target make v1 fragments platform/target-specific. The reuse
  win is across flows sharing that effective context; cross-platform journeys require separately
  recorded fragments and separately pinned callers.
- Source bundles and preflight must carry and validate a transitive closure, while digest identity
  remains content-addressed and independent of local absolute paths.
- Composed failures are more useful to agents because the local step and control path remain stable
  when unrelated siblings are added or expanded. V1 address-aware resume is explicit at root and
  fragment boundaries, while a mid-body resume remains refused until it has a state precondition;
  neither can be safely approximated by a global index.
- V1 deliberately does not make fragments standalone tests. A parent `.ad` owns the `open` and
  `close`; a fragment is reusable session work, not a hidden lifecycle script.

## Alternatives considered

- **Post-hoc slicing of `session.actions`: rejected.** The recorder no longer has the capture-time
  target tree, so a slice cannot reconstruct ADR 0012 evidence or prove its entry screen. This also
  repeats the late-publication problem rejected by ADR 0016.
- **Put `open`/`close` in every fragment: rejected.** Reuse would relaunch or tear down a caller's
  session, making composition non-local and making shared login paths impossible to invoke safely.
- **Infer an entry guard from a screenshot, full snapshot, or last action: rejected.** Screen identity
  is app semantics. Requiring a caller-selected, identity-bearing landmark reuses the verified
  `wait` contract instead of inventing a cross-platform fingerprint.
- **Expand all fragments into one flat global plan: rejected.** ADR 0012's Maestro include incident
  showed that expansion-only provenance shifts ordinals and loses the included source boundary. A
  nested plan may execute actions in order, but it must retain the fragment address at every step.
- **Use path-only or floating includes: rejected.** A shared file can change between authoring and
  replay. Digest pinning makes the change a preflight decision rather than a hidden behavior change;
  `--update` cannot become a package manager.
- **Build a second shared replay engine: rejected.** ADR 0015's direct typed Maestro engine already
  owns its control semantics and performance contract. Sharing only composition identity and
  provenance gives both engines one contract without duplicating dispatch, polling, or matching.
- **Automatically heal a stale or divergent fragment: rejected.** ADR 0012 retired unattended
  rewriting because selector agreement is not proof of target identity. Re-recording remains an
  explicit author action until a fragment-specific repair contract exists.

## Validation and implementation sequence

This spike adds no executable implementation or regression test because it changes no runtime
behavior. The current codec, source-bundle, plan-digest, and Maestro include tests were audited to
anchor the seams that the implementation must preserve. The implementation must land in
independently reviewable slices, with every new structural gate observed failing against a planted
violation before the production change is trusted.

The audited seam tests are `packages/ad-script/src/internal/__tests__/script.test.ts`,
`packages/ad-replay/src/internal/__tests__/plan-digest.test.ts`,
`src/commands/replay/script-source-bundle.test.ts`, and
`packages/maestro/src/internal/__tests__/replay-plan.test.ts`,
`source-closure.test.ts`, `program-loader.test.ts`,
`src/daemon/handlers/__tests__/session-replay-runtime.test.ts`. The planted-red checks below are
unit or fixture assertions owned by the slice that introduces them; they are not a claim that this
docs-only spike already has a structural gate.

The old-reader dispatch seam is `src/core/dispatch.ts`; the existing keyboard-dispatch test is not
evidence for unknown-command rejection.

1. **Shared pure model and canonical fixtures.** Add typed composition nodes, fragment identity,
   invocation paths, local addresses, digest canonicalization, cycle/depth/size validation, and
   preflight result types without dispatch. Fixtures must prove that two invocations share a digest
   but not an address, inserting a sibling include does not change an unaffected local address, a
   child edit changes all and only its transitive callers' composition digests, and source paths are
   diagnostics rather than hidden global ordinals. Also prove that ordinary comments, whitespace,
   timestamps, device names, and absolute source paths excluded by the canonicalization rules leave
   `fragmentDigest` unchanged. Prove repeated logical steps get distinct control paths, and that a
   nonzero iteration path is reported but refused for v1 resume. Plant a missing address/digest edge
   and verify the unit gate names it before restoring the implementation.
2. **Native fragment codec and source closure.** Extend the `.ad` codec with the first-executable
   `fragment-v1`/`composition-v1` guards, pinned reference, include control, lifecycle admission,
   parse/write/parse round trips, relative source resolution, and old-reader guard behavior. Extend
   the caller-side source bundle to ship the complete closure and execute the exact verified bytes.
   Classify every existing descriptor that is allowed in a fragment before exposing capture. Plant
   each of a missing digest, duplicate or missing `callSiteId`, and an admitted `open`, then pass a
   guarded composition containing `composition-v1`, `open`, and `include` to the old reader and
   observe the guard fail before the `open` handler. Separately fixture an unguarded legacy script
   with a known prefix before an unknown command as explicitly out-of-scope behavior; do not use it
   as v1 safety evidence. Also test the new reader's `fragment_composition_required` refusal for a
   direct fragment replay.
3. **Capture and publication.** Add the explicit fragment capture aggregate and session commands.
   Reuse the existing recorder/evidence/parameterization and atomic writer seams. Test the automatic
   verified entry guard, identity-empty/ambiguous refusal, no `open`/`close`, retry after target
   collision, abort-without-file, close-after-abort without a stranded claim, and a real saved body
   whose first local step is the guard. Plant a guardless fragment, an `open` body, an undeclared
   command, and overlapping ordinary-publication/repair transactions to prove each gate fails in
   the intended direction.
4. **Native composed replay and address-aware resume.** Resolve and verify the full graph before
   step 1, execute nested invocations in parent order without flattening identity, publish local
   addresses in progress/traces/divergence, and require the matching composition digest for resume.
   Test repeated/nested invocation paths, stale child refusal, entry-guard mismatch, and an inserted
   earlier include that leaves later local addresses unchanged. Test root addresses,
   `fragment_context_mismatch`, `fragment_variable_unbound`, and the
   `fragment_repair_unsupported` refusal. Test that an address resume at an invocation boundary
   reruns guards, rejects a mid-body fragment resume, compares only stable address fields, and
   reports source lines diagnostically. Keep flat-script `--from N` tests unchanged. Plant a
   global-index-only report and a numeric resume against a native composed plan; both must fail the
   unit gate. Include a cold-replay smoke fixture with a root `open`, a pinned `include`, and a
   root `close` so the lifecycle boundary is exercised by the same parent artifact used for address
   assertions.
5. **Maestro integration below the typed interpreter.** Adapt the existing source-preserving
   `runFlow` plan/interpreter to emit the shared invocation/provenance/digest records while retaining
   scoped env, conditions, runtime controls, and its loader. Extend the existing include/source
   provenance and conformance tests; assert file-backed `runFlow` uses the existing compiled-plan
   digest when an expected digest is supplied, while inline and skipped controls retain their typed
   semantics. Test derived call-site/control identities, repeated and retrying execution paths, and
   their nonzero-iteration resume refusal. Do not route Maestro through native `.ad` parsing or a
   recursive daemon replay switch. Plant a flattening adapter and verify the source/address test
   catches it.
6. **Provider and live validation.** Add provider-backed record → publish → compose → cold-replay
   scenarios, stale-edit refusal before device work, repeated-fragment address reporting, and iOS
   plus Android evidence for real entry guards and lifecycle ownership. The existing fixture tests
   prove contracts only; they do not replace the live device evidence required for a merge-ready
   implementation. Both iOS and Android evidence rows must be green to complete this slice and
   release the cross-platform public fragment/composition surface. If one lane is unavailable, the
   implementation remains incomplete and the gap is reported with the exact failing precondition
   and typed error/details captured; it is residual live-device/OS evidence, not a code failure.
