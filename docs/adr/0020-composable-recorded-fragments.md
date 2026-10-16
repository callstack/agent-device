# ADR 0020: Composable Recorded Fragments

## Status

Proposed design spike for [#1336](https://github.com/callstack/agent-device/issues/1336).
This ADR settles the artifact and ownership contract.
Implementation is intentionally a later, separately reviewable sequence.

## Context

The E3 repair-economics matrix measured re-recording as cheaper than agent repair for two cases:

- label drift: $1.21 versus a $2.34 repair median;
- cascade drift: $1.55 versus $2.05.

Repair won only for a single diverged read ($0.69).
That single-read figure is a repair-only baseline.
The re-record comparison is the label/cascade rows.
Therefore, re-recording is the repair path, and the useful lever is the unit that is re-recorded.
If thirty flows share a login journey, the reusable unit should be one fragment, not thirty closed scripts.

Today, a native `.ad` recording is a closed unit.
Its `open` establishes the session, and its `close` tears the session down.
ADR 0016 deliberately stopped at open-to-destination publication and left arbitrary slices for this decision.
The reason is that target evidence is captured at action time, and is not reconstructed from history.
ADR 0012 also makes the cost of lost composition provenance concrete.
A Maestro include that was flattened into one plan shifted step ordinals.
That made divergence attribution and the line table of the include ambiguous.
ADR 0015 now requires Maestro to remain a source-preserving typed interpreter.
That interpreter owns `runFlow`, scopes, conditions, repeats, retries, and include loading.

Consequently, the design must solve four boundaries together:

- A fragment cannot hide session lifecycle.
- The first action must prove the entry screen.
- A fragment edit must invalidate exactly the compositions that use it.
- A failure must name a local step and invocation, not an expanded global ordinal.

## Rules at a glance

1. **A native recorded fragment is a lifecycle-free body.**
   Its composing flow owns `open`, context, launch state, session ownership, and `close`.
   A native fragment has no `open` or `close`.
   To invoke it never relaunches or tears down the session.
   Maestro subflows retain their typed-flow lifecycle semantics under ADR 0015.
2. **Native capture is explicit and entry-guarded.**
   `session fragment start <path> --entry <selector>` captures a verified landmark as the first recorded `wait`.
   `session fragment save` publishes the body and does not close the session.
   Post-hoc history slicing is not a supported native capture path.
3. **Composition is one semantic model, not one engine.**
   Native `.ad` `include` and Maestro `runFlow` produce the same invocation boundaries, provenance records, address construction, and structured failure projection.
   Format-owned parsers and interpreters retain identity, digest, lifecycle, and execution semantics.
   Neither format lowers the other into a second replay engine.
4. **Native references are digest-pinned.**
   A persisted native `.ad` include carries a relative locator.
   It also carries the expected content digest of the fragment that it resolved when it was authored.
   A missing, changed, cyclic, or unsupported native fragment fails preflight before any device action.
   Maestro `runFlow` keeps its ADR 0015 source-preserving loader and existing compiled-plan digest.
   It does not adopt the native comment syntax.
   For native artifacts, there is no implicit "latest" fallback and no silent repinning.
5. **Addresses are owner-local.**
   The address of a composed step is its fragment digest or root composition digest, its invocation/control paths, and its local step ordinal.
   `source.path:line` remains diagnostic provenance.
   A global `displayOrdinal` may be retained as bounded display data.
   But it never authorizes resume, and it never appears inside the address.
6. **Existing target evidence remains the contract.**
   The entry guard and element actions reuse ADR 0012's `target-v1`/`targets-v1` annotations and verification.
   Every v1 native fragment and composed parent starts with a required first-executable format guard (`fragment-v1` or `composition-v1`).
   A new reader consumes that guard during preflight.
   An old reader treats the guard as an unknown action.
   The required safety property is failure before platform execution, before a root `open` or any known prefix.
   An old reader fails with its existing errors, not `INVALID_ARGS`; see Annotation compatibility and versioning.
   Other fragment metadata and references remain reserved comments.
   Thus old readers ignore those annotations, and do not silently flatten the composition.
7. **Native fragment repair is explicit re-recording.**
   Native `.ad` `replay --save-script` does not flatten a composed plan into a monolithic healed script.
   Until fragment-specific repair is implemented, the caller re-records the affected fragment and explicitly repins its callers.
   Maestro retains its existing unsupported-`--save-script` behavior.

## Decision

### Fragment artifact and lifecycle ownership

A v1 fragment is a portable `.ad` body with a required first-executable format guard and no session lifecycle.
Its shape is conceptually:

```text
fragment-v1
context platform=ios target=mobile
# agent-device:target-v1 {"id":"home","role":"heading","label":"Home","ancestry":[],"sibling":0,"viewportOrder":0,"verification":"verified"}
wait "id=\"home\""
click "label=\"Continue\""
```

The exact writer surface belongs to the future implementation.
But these invariants are fixed:

- **Format guard and context:** `fragment-v1` is the required first-executable format guard.
  The new reader consumes it during source preflight.
  It is a format envelope, not a `SessionAction`, and it has no device side effect.
  A composed native parent uses the corresponding `composition-v1` guard as its first executable line, before root `open` or any `include`.
  An old reader parses either guard as an unknown action.
  The required safety property is failure before platform execution.
  An old reader returns its existing, session-dependent errors; see Annotation compatibility and versioning.
  The fragment has no `open`, `close`, or hidden launch action.
  The writer always emits the effective `context platform` and `target`.
  A parser rejects a fragment that is missing either constraint.
  Those values constrain the effective platform/target, but they do not select a device or establish a session.
  The parent supplies those facts.
- **Entry guard:** the first executable step is an identity-bearing selector `wait` with `target-v1` evidence whose `verification` is `verified`.
  It is the entry guard of the fragment, and it is included in the fragment digest.
  The guard uses the existing landmark-mode polling and identity semantics.
  It is not a screenshot fingerprint or a best-effort label check.
  Its timeout is the exact existing `wait` positional budget.
  `start` accepts an optional entry-timeout.
  If the entry-timeout is omitted, capture resolves the current selector-runtime default once and writes that concrete millisecond value into the guard.
  Therefore, published fragments never depend on a future runtime default, and a change of the default does not invalidate existing digests.
- **Body codec:** the body uses the existing recorded-action codec, selector-chain optimization, target evidence, and ADR 0017 parameterization rules.
  It does not introduce a second annotation format or a fragment-specific target matcher.
- **Admission:** the command descriptors and recording traits decide fragment admission.
  The fragment writer does not exclude session lifecycle, device ownership, recording publication, and other resource-owning commands through a duplicate hand-maintained command-name list.
  Admission is an allowlist over a positive fragment-safe descriptor trait.
  A command without that declaration is refused before arming or replay.
  Thus a future command cannot become fragment-safe by omission.
  During an armed capture, such a command is refused before dispatch, and the capture remains armed and retryable.
  During replay, the complete plan is rejected in preflight.
  Before the implementation enables the new surface, it must classify every currently supported recording command.
- **Variable scope:** a fragment invocation inherits the effective session, context, and late-bound native `${VAR}` scope of the parent.
  Preflight enumerates the names that the fragment references.
  It refuses an unbound name with `fragment_variable_unbound`, and it does not expand the value of the name into the digest.
  V1 has no per-invocation argument or output-variable contract.
  Names resolve in the inherited flat scope, with no fragment-local shadowing.
  Callers provide values through the existing script/header/shell mechanisms.
  Maestro's scoped environment and output semantics remain those of its typed `runFlow` interpreter under ADR 0015.

The **session** owns the live device and app.
A separate **fragment capture aggregate** owns the capture buffer, the entry guard, the target path, and the `ARMED`/`PUBLISHED`/`ABORTED` publication state.
It does not become a second session lifecycle, and it does not append a synthetic `close`.
The ordinary session action log continues to accumulate beside the fragment buffer.
The fragment capture is mutually exclusive only with an ordinary script-publication transaction and an ADR 0012 repair transaction.
The reason is that overlapping publications would make ownership and provenance ambiguous.

The fragment body cannot contain lifecycle `open` or `close`.
While capture is armed, a new session/open request or an ordinary recording/repair transaction is refused before platform dispatch.
The refusal is `fragment_capture_conflict` with `{sessionState: "fragment_armed", conflictingOperation}` details.
A session-ending `close` instead aborts the armed capture without publishing a file.
Then it performs the ordinary close and device-claim release.
Client disconnect or lease expiry aborts the capture as well.
`save` and an explicit `abort` leave the underlying session active.

The session action log is retained for diagnostics and ordinary command history.
But a session that has armed or published a fragment is not eligible for ordinary open-to-destination publication.
A later ordinary publication request returns `fragment_capture_conflict` and tells the caller to start a fresh session.
This prevents a silent second emission of the same journey: once as a fragment and again as an unmarked closed script.

### Recording UX: start at the boundary, never slice after the fact

The v1 authoring workflow is an explicit in-session boundary:

```sh
agent-device session fragment start ./fragments/login.ad --entry 'id="Home"'
# perform the reusable login journey with ordinary commands
agent-device session fragment save
```

`--entry` is a portable selector expression, not a session-local `@ref`.
When capture starts, it resolves the selector against the current observation.
It records the equivalent selector `wait` plus fresh `target-v1` evidence as local step 1.
Start refuses before arming in these cases: the selector is absent, ambiguous, or identity-empty, or it otherwise cannot produce verified landmark evidence.
This makes the entry precondition explicit, and the guard in the artifact stays automatic.
A caller may abort and retry in the same live session.
A caller cannot ask the writer to infer a screen identity from a snapshot or from a history range.

`session fragment save` uses the target path that `start` fixed.
It uses the existing same-directory atomic publication and the no-clobber default from the script writer.
There is no alternate save path that could disagree with the armed aggregate.
To change the destination, abort and start again.
A target collision, a serialization failure, or an invalid fragment body leaves the capture armed and retryable.
A successful save is the only transition to `PUBLISHED`.
`--force` is an explicit replacement authorization.
A new body published at the old path intentionally makes callers that hold the old digest stale.
Therefore, versioned paths are recommended for shared fragments.
An interrupted or aborted capture publishes no partial fragment.

This is deliberately not a post-hoc slice of `session.actions`.
ADR 0012's target evidence is computed from the tree at resolution time.
It cannot be reconstructed reliably after the session has moved.
Therefore, existing active-session publication remains an open-to-destination artifact.
Fragment capture has its own explicit boundary and first-step guard.

### One composition model below two interpreters

The future implementation introduces a small shared **composition/provenance model**, not a shared replay VM.
Its records are semantic data that both engines use:

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
- preflight errors for missing, stale, cyclic, or unsupported fragments;
- the structured failure projection that carries the local address.

The model does **not** own selector matching, platform dispatch, Maestro conditions, repeat/retry polling, or native `.ad` parsing.
Native `.ad` parsing recognizes an `include` control and builds a nested invocation node.
Maestro keeps `runFlow` in its source-preserving typed IR and interpreter.
When the interpreter loads a child program, it contributes the same invocation/provenance records.
Maestro's `runFlow` controls, scoped variables, optional behavior, and runtime repeats remain Maestro-owned, as ADR 0015 requires.
The shared model prevents a second semantic implementation.
It does not move `runFlow` out of that interpreter.

A composed native parent has a required `composition-v1` first-executable guard before its root `open` or any `include`.
A flat native `.ad` script without an include keeps the existing artifact shape and behavior.
The new source preflight consumes the guard, and the guard is not a device action.
Its purpose is to make an old reader fail at the format boundary, and not partially execute a new composed artifact.

V1 does not allow cross-format includes.
Native `.ad` `include` loads a native fragment, and Maestro `runFlow` loads Maestro programs.
They share the composition contract.
They do not share a coercion path that would make either parser interpret the syntax of the other.

The pinning surface is format-specific:

- A native persisted include must carry the `fragment-ref-v1` expected digest.
- A file-backed Maestro `runFlow` contributes the child source closure and its existing compiled replay-plan digest to the shared identity/provenance records.
  A caller can supply an expected Maestro plan or composition digest.
  If the loaded closure changed, that caller gets the same preflight stale failure.
- With no expected Maestro digest, ADR 0015's existing behavior intentionally loads the current source closure and produces its new plan identity.
  This does not authorize native `.ad` to float to a newer file.
- In v1, an inline Maestro `runFlow: commands:` body remains a typed control node, not a file-backed fragment.
  Thus it has no fragment locator and no standalone fragment address.
- A skipped conditional invocation creates no child invocation or iteration ordinal.
  Only executed iterations get ordinals.

The native entry-guard, lifecycle-admission, and lifecycle-free artifact rules apply only to the recorded `.ad` fragment format.
Maestro subflows retain their existing typed-flow preconditions, and they may contain Maestro-owned lifecycle or control commands.
The shared model records their boundaries and provenance, and does not coerce them into a native fragment body.

Maestro supplies the shared identities from its typed IR, not from new YAML fields.
A `runFlow` call-site ID is a format-tagged digest of these inputs:

- the canonical typed node;
- its resolved source-bundle-relative locator;
- its local occurrence among otherwise identical sibling nodes.

`repeat`/`retry` control IDs use the same rule.
Source lines and expanded plan ordinals are excluded.
These IDs are internal to the compiled plan, not author-facing syntax.
A change to the node or its local structure changes the existing Maestro plan digest and invalidates old addresses.
The local occurrence discriminator only distinguishes identical authored siblings within one plan.
It is not used as a global step identity.
Maestro addresses are stable only within their matching compiled plan digest.
A source edit, including an earlier identical sibling, intentionally invalidates the old address.
This ADR does not promise cross-edit call-site stability.

An include is a control boundary, not a `SessionAction`.
Its child actions are recorded and executed inside the live session of the parent.
But the boundary remains visible to planning, tracing, failure reporting, and digest construction.
Nested fragments are allowed, subject to cycle detection and a bounded source/depth policy.
That policy is shared with Maestro's existing source-bundle limits.

### Pinned references, fragment digests, and staleness

The native representation uses a reserved reference comment immediately before its include control:

```text
# agent-device:fragment-ref-v1 {"callSiteId":"login-entry","digest":"sha256:<64 lowercase hex>"}
include "./fragments/login.ad"
```

The caller-side source bundle resolves the include path relative to the including source.
The `callSiteId` is the persisted identity of this authored include occurrence.
The writer preserves it when the node is edited in place, and it assigns a new value to a new occurrence.
It is required, and it is unique within its parent.
Duplicate or missing values fail preflight with `fragment_call_site_invalid`.
The digest is the fragment identity.
The path is only a locator and a source-provenance hint.
A future implementation may choose an equivalent inline spelling.
But it must preserve the call-site identity, the locator, and the digest.
It must not accept an unpinned native include in a persisted composed plan.

`fragmentDigest` is SHA-256 over canonical JSON for the parsed fragment IR, including:

- the fragment format/canonicalization version;
- effective platform/target constraints;
- the verified entry guard;
- the normalized command, inputs, execution-affecting flags/runtime hints, and `target-v1`/`targets-v1` evidence of every executable action;
- every nested pinned fragment reference, its `callSiteId`, and its child digest.

For a native parent, the authored relative locator of each nested include is part of that parent reference IR.
The absolute resolved filesystem path is excluded.
Therefore, a child move keeps the child digest, but it requires an explicit parent locator edit and parent repin.

The digest excludes session timestamps, device names, absolute source paths, and ordinary comments.
Native `${VAR}` placeholders remain unresolved in the digest, as ADR 0012's late-bound-value rule requires.
Maestro's effective static environment and parse-time expansion continue to participate in the Maestro plan digest under ADR 0015.
A changed target annotation changes the digest because the annotation changes execution-time verification.
The reason is not that the annotation is diagnostic text.

The shared identity is `(format, digest)`.
It is not a promise that native and Maestro source languages produce the same hash.
Each format keeps its existing canonical JSON implementation and carries its canonicalization version in the identity input.
The shared model compares the typed identity and dependency edges.
Format-owned parsers define the bytes that are canonicalized.

`compositionDigest` is SHA-256 over these inputs:

- the canonical root plan;
- the ordered include call-site semantics;
- the transitive graph of **pinned expected** fragment identities.

It is not a hash of every file in the directory of the caller or in the source bundle.
A valid composition digest is computed only after the complete closure is resolved and every expected digest matches the bytes that will execute.
Consequently, an edit to a leaf changes its digest and immediately invalidates its direct callers.
But it does not change the own digest of an ancestor fragment until the pin of that ancestor is explicitly updated.
A repin of the parent then changes its digest and invalidates the next caller.
Thus the bottom-up walk is intentionally N levels.
An unrelated fragment does not invalidate callers that do not reference it.
To move an unchanged child requires an explicit locator update in its parent.
The content identity of the child does not change.
`callSiteId` participates in the canonical fragment IR.
Thus a rename of a `callSiteId` intentionally changes the digest of that fragment.
It triggers the same explicit bottom-up repin as a change to an execution-affecting action.

The complete source closure is resolved and digest-checked before step 1.
The resolver returns the verified bytes.
Parsing, digest calculation, and execution all consume those same bytes.
A second filesystem lookup cannot replace the checked artifact.
These cases fail closed without device or session side effects:

- The pinned file is missing from the source bundle of the caller.
- The actual canonical digest differs from the expected digest.
- The fragment format or canonicalization version is unsupported.
- An include cycle occurs, or a source/depth/size bound is exceeded.
- The fragment violates lifecycle or entry-guard admission.
- Its platform or target constraints are incompatible with the effective context of the parent.
- A referenced native variable is absent from the inherited scope.

Source-closure preflight uses the existing `INVALID_ARGS` family for caller-side input/source validation under ADR 0010.
Its machine reason is one of these:

- `fragment_missing`
- `fragment_unsupported`
- `fragment_bounds`
- `fragment_cycle`
- `fragment_call_site_invalid`
- `fragment_control_identity_invalid`
- `fragment_stale`
- `fragment_lifecycle`
- `fragment_entry_guard`
- `fragment_context_mismatch`
- `fragment_variable_unbound`

Its details include the including source, the locator, the expected digest, the actual digest when available, and the call-site.
Agents branch on `details.reason`, never on message text.
Source-closure preflight never silently loads the newest file, rewrites the parent, or executes a valid prefix before it discovers a stale child.
`--update` remains ADR 0012's no-write suggestion surface, and it cannot repin a fragment.

Request-state and artifact-kind validation also uses `INVALID_ARGS`.
But it has a separate details contract, and it is not a source-closure error.
Its reasons and details are these:

| Reason | Details |
| --- | --- |
| `fragment_resume_mismatch` | Expected/current composition identity |
| `fragment_resume_unsupported` | Expected/current composition identity |
| `fragment_composition_required` | Artifact kind/source |
| `fragment_capture_conflict` | Session state/conflicting operation |
| `fragment_repair_unsupported` | Command and format |

These details name the command/session state or the expected/current composition identity.
They do not pretend that source locator and digest fields exist.
The capture conflict is a same-session transaction-state refusal, not `DEVICE_IN_USE`.
`DEVICE_IN_USE` remains reserved for a device that another session claims.

Source-closure preflight reports the first applicable reason in this total order:

1. Missing source
2. Unsupported format/version
3. Source bound
4. Depth bound
5. Size bound
6. Include cycle
7. Missing/duplicate call-site identity
8. Missing/duplicate control identity
9. Stale digest
10. Lifecycle violation
11. Missing entry guard
12. Entry-guard evidence mismatch
13. Context mismatch
14. Unbound variable

Therefore, a stale child wins before a composition digest can be computed.
A resume supplied against that failed closure reports the child `fragment_stale`, not `fragment_resume_mismatch`.
Request-level checks apply only after a valid composition digest exists.
Then a mismatched expected composition digest is `fragment_resume_mismatch`, and an unsupported resume shape is `fragment_resume_unsupported`.
A fragment opened without a composing parent is `fragment_composition_required`, and it is outside source-closure ordering.

### Stable addressing, divergence, and resume

Every executable step inside a fragment receives a local address.
The conceptual wire shape is:

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

`localStep` is the 1-based logical executable step within the owner fragment, including its entry guard.
An invocation path is made from persisted include `callSiteId` values and explicit runtime invocation ordinals.
Source path/line is diagnostic provenance only.
`controlPath` adds persisted typed-control identities and runtime iteration/attempt ordinals for repeat, retry, and other format-owned controls.
Every addressable repeat/retry node must provide a `controlId` that is unique within its owner.
A missing or duplicate identity fails with `fragment_control_identity_invalid`.
The path distinguishes repeated executions of the same logical local step.
It is empty for a native fragment without such controls.
Neither path is a position in the fully expanded global action array.

Therefore, two invocations of the same fragment share its digest but have distinct invocation paths.
An earlier inserted fragment does not renumber the local steps of a later fragment or change its authored call-site identity.
An edit to the fragment changes its digest and intentionally invalidates old addresses.

A composed root also has addresses:

- Its owner is `{kind: "root", format, compositionDigest}`.
- Its `invocationPath` is empty.
- `localStep` is the 1-based logical root step.

Any composition-digest change invalidates a root address.
A change to its fragment identity or its enclosing composition identity invalidates a fragment address.

Only these fields participate in address equality or resume authorization:

- `address.version`
- `owner`
- `invocationPath.callSiteId`
- `invocationPath.iteration`
- `controlPath.controlId`
- `controlPath.iteration`
- `localStep`

`provenance` is a sibling display/diagnostic field, and it is never compared for authorization.
A source comment or formatting edit can change its line without a change to an otherwise valid address in the same published composition.

Runtime iteration and attempt values are execution evidence, not a second source of identity.
They are emitted for divergence and tracing.
But v1 address-aware resume accepts only an invocation and control path that meets both of these conditions:

- All its iteration/attempt values are `0`.
- Its controls are statically reachable.

A nonzero or runtime-conditional path is refused with `fragment_resume_unsupported`.
The matching composition digest cannot by itself reconstruct which dynamic iterations occurred.

The existing flat `.ad` contract remains unchanged for scripts with no composition.
Its numeric `step.index`, `--from N`, and `--plan-digest` continue to work as ADR 0012 specifies.
A composed native `.ad` composed plan adds `step.address` and `resume.address` for root and fragment steps.
It requires a matching `compositionDigest` for any address-aware resume.
A `displayOrdinal` can be included as bounded display/progress data.
But it never authorizes resume, and it never appears inside an address.
The future native CLI/Node/MCP surface may encode an address behind the existing `--from` option or an additive opaque resume token.
It must not make callers guess which flattened ordinal identifies a repeated fragment.
A numeric `--from` supplied to a native composed plan is rejected until the address-aware path is available.

Maestro keeps its existing format-owned numeric `from` plus `planDigest` resume contract while its typed-interpreter slice adds the shared address fields.
This ADR does not remove that working surface.
Maestro YAML continues to reject `--save-script` with its existing format error, because ADR 0012 repair recording applies only to native `.ad` scripts.
The native address and repair rules are not retroactively applied to Maestro.

V1 address-aware resume is legal only for a composed root step and for a fragment invocation boundary (`localStep: 1`).
Fragment addresses for later local steps remain required for traces, progress, and divergence.
But a resume at a later local step is refused with `fragment_resume_unsupported`.
The entry guard is an entry-only precondition, not a screen invariant.
To rerun it after earlier fragment actions would be incorrect.
A future ADR may add per-step preconditions or a safe replay prefix.
V1 does not pretend that a local address alone proves the device state for a mid-body resume.
At a nested fragment boundary, only the local-step-1 guard of the target fragment executes.
Ancestor invocation steps and ancestor guards are not replayed, because the caller owns the skipped parent state.
Local step 1 is counted once for the target invocation.

Root-step resume retains the existing flat `--from` responsibility.
The caller supplies the session state for skipped root actions.
The matching composition digest proves only that the plan is the same.
Root steps have no fragment entry guard.
Thus this is compatibility with the established flat resume contract.
It is not a claim that a root local address proves the device state.

A target-binding or action failure inside a fragment keeps ADR 0012's `REPLAY_DIVERGENCE` code, bounded screen, repair hint, and structured cause.
Its step provenance also names the fragment digest, invocation path, control path, local step, and source path/line.
A failure while the include loads or is validated names the include call-site instead, and it occurs during preflight.
No error projection is allowed to collapse a fragment failure to a parent global ordinal.

### Annotation compatibility and versioning

`fragment-v1` and `composition-v1` are reserved first-executable format guards, not comment forms or target annotations.
`# agent-device:fragment-ref-v1` remains a reserved reference comment.
The first entry `wait` and every element-targeting action continue to carry the existing `target-v1`/`targets-v1` evidence.
That evidence keeps its size limits, canonical field order, and fail-closed `verification` behavior.
Readers that do not know the reference annotation ignore that comment.
Readers that do not know the executable guard must fail before platform execution.

The new reader consumes the native guard during source preflight.
An old reader can get either a v1 fragment or a composed parent.
It parses the guard as an ordinary action.
The current parser is `parseReplayScriptLine` in `packages/ad-script/src/internal/script.ts`.
It accepts an unknown command name without format validation.
The replay engine dispatches that action through `invokeReplayAction` in `packages/replay-port/src/daemon-port/session-replay-action-runtime.ts`.
An unknown command has no `replayScopedAction` trait, so `createReplayScopedActionInvoker` uses the full request path.
`getDaemonCommandRoute` selects `generic`, and `runRequestHandlerChain` returns no handler response.

After request admission succeeds, `dispatchGenericForLockedScope` in `packages/daemon/src/server/request-router.ts` checks the session first.
If no session exists, it returns `SESSION_NOT_FOUND` through `noActiveSessionError`.
If a session exists, it calls `resolveGenericRuntimeExecution` in `packages/daemon/src/execution/generic-runtime-execution.ts`.
For an unknown guard, that resolver returns `COMMAND_FAILED` with reason `generic-route-runtime-missing` before platform execution.
These are responses for the guard request, not the outer replay response.
The replay adapter wraps this dispatch failure as `REPLAY_DIVERGENCE`.
The replay engine stops at the failed action before a later root `open`, known prefix, or expanded child body.

This trace proves failure before platform execution for an unknown guard that reaches generic dispatch.
Admission can resolve a device for lock and provider selection; that resolution reads the device inventory and runs no command.
This trace does not cover failures during admission.
A new fragment codec cannot change an old reader's behavior.
Thus the old-reader contract accepts these existing errors: `SESSION_NOT_FOUND`, or `COMMAND_FAILED` with reason `generic-route-runtime-missing`, wrapped as `REPLAY_DIVERGENCE`.
The contract does not require `INVALID_ARGS` from an old reader.
A reader that ships with the fragment codec would refuse an unknown or malformed guard with `INVALID_ARGS` during source preflight.
An old reader that gets an unguarded legacy `.ad` retains its existing behavior.
This includes the possibility that it executes a known prefix before a later unknown command.
That legacy case is explicitly outside the v1 composed-artifact acceptance contract, and it is not safety evidence.
The new reader rejects a fragment supplied as a top-level replay artifact with `fragment_composition_required`.
Unknown future reference comments remain ordinary comments to an older reader.
An unknown future executable guard has the same required safety property.

`packages/daemon/src/execution/__tests__/generic-route-runtime-completeness.test.ts` verifies the resolver's unknown-command branch.
It does not exercise the full replay path or the missing-session branch.
Its unknown-command test proves the routing-gap response, not the proposed fragment format contract.
The fragment codec implementation must add planted-red tests with these properties:

- They run a guarded composition with `open` through the old dispatch path.
- They assert that the guard fails before the handler.
- They separately preserve the legacy-prefix fixture as out of scope.

The fragment codec implementation must also add strict reserved-header/reference parsing tests.
This ADR does not pretend that those tests exist yet.

Format-version changes, digest canonicalization changes, and address-shape changes are breaking composition boundaries.
A reader must not reinterpret a v1 digest under a new canonicalizer.
A minor additive annotation that preserves the v1 execution contract may remain an ignored comment, under ADR 0012's old-reader rule.
But any change to lifecycle, entry verification, or digest meaning requires a new version and an explicit migration.
Each version gates one contract:

- The first-executable fragment or composition guard version gates the body grammar.
- The reference version gates the pinned-reference schema.
- The address version gates the wire address.
- The canonicalization version is part of the digest input.

A mismatch in any one is a preflight `fragment_unsupported` error.

### Repair and migration boundaries

These items are intentionally not part of the implementation of this spike:

- automatic extraction of fragments from an existing `.ad` or from arbitrary session history;
- fragment parameters, output variables, or a registry/content-addressed remote store;
- cross-format native/Maestro includes;
- silent repinning, auto-versioned output names, or `--update` writes;
- fragment-aware `replay --save-script` healing.

Existing closed `.ad` scripts and ADR 0016 open-to-destination scripts remain byte/behavior compatible.
To migrate, a user does these steps:

1. Start a fresh fragment capture at the desired boundary.
2. Choose a stable entry selector.
3. Publish the fragment under a new path.
4. Add a digest-pinned include to a parent.

No existing script is rewritten or inferred to be a fragment.
Ordinary recording and ADR 0012 repair remain separate capture lifecycles.
They refuse to overlap a fragment capture, and they do not produce a hybrid artifact.

If a composed replay diverges inside a fragment, the agent receives the fragment-local address.
The agent must either repair application state or re-record that fragment explicitly, then update the pin of the parent.
A future fragment-repair ADR may reuse ADR 0012's agent-supervised "heal-by-doing" mechanics.
But it must publish a fragment body with a guard and preserve its digest boundary.
It may not flatten a composition as an accidental fallback.
Native `.ad` `replay --save-script` on a composed plan is refused with `fragment_repair_unsupported` until that fragment-specific contract exists.
It never silently writes a root-only script or a flattened replacement.

Nested digest changes are repinned explicitly from the changed leaf upward:

1. The author publishes the new child.
2. The author updates each direct include and republishes that parent.
3. The author repeats this for its direct callers until the root is current.

Each step is a deliberate file edit or a future dedicated tooling operation.
No replay command writes pins.
Preflight reports the dependency chain, so the author can see the remaining stale ancestors.
This is the intentional v1 tradeoff: stale reuse stays visible, and multiple flows do not change implicitly.

## Consequences

- A shared login or navigation journey becomes one independently reviewable, re-recordable artifact.
  The parent retains ownership of session setup and teardown.
- Entry guards add one bounded wait and one identity capture at authoring time.
  But they prevent a reused fragment from silently acting on the wrong screen.
- A fragment edit intentionally creates explicit, actionable staleness for every pinned caller.
  This adds repinning work, but it avoids a silent change to thirty flows at once.
- V1 has no fragment arguments or output variables, and it inherits one flat parent scope.
  Thus one flow cannot invoke the same fragment with two independent variable sets.
  Until a parameter contract is accepted, callers that need that isolation must use separate parent scopes or separately authored fragments.
- The required captured platform and target make v1 fragments platform/target-specific.
  The reuse win is across flows that share that effective context.
  Cross-platform journeys require separately recorded fragments and separately pinned callers.
- Source bundles and preflight must carry and validate a transitive closure.
  Digest identity remains content-addressed and independent of local absolute paths.
- Composed failures are more useful to agents, because the local step and control path remain stable when unrelated siblings are added or expanded.
  V1 address-aware resume is explicit at root and fragment boundaries.
  A mid-body resume remains refused until it has a state precondition.
  A global index cannot safely approximate either one.
- V1 deliberately does not make fragments standalone tests.
  A parent `.ad` owns the `open` and `close`.
  A fragment is reusable session work, not a hidden lifecycle script.

## Alternatives considered

- **Post-hoc slicing of `session.actions`: rejected.**
  The recorder no longer has the capture-time target tree.
  Thus a slice cannot reconstruct ADR 0012 evidence or prove its entry screen.
  This also repeats the late-publication problem that ADR 0016 rejected.
- **Put `open`/`close` in every fragment: rejected.**
  Reuse would relaunch or tear down the session of a caller.
  That makes composition non-local, and it makes shared login paths impossible to invoke safely.
- **Infer an entry guard from a screenshot, full snapshot, or last action: rejected.**
  Screen identity is app semantics.
  A caller-selected, identity-bearing landmark reuses the verified `wait` contract, and no cross-platform fingerprint is necessary.
- **Expand all fragments into one flat global plan: rejected.**
  ADR 0012's Maestro include incident showed that expansion-only provenance shifts ordinals and loses the included source boundary.
  A nested plan may execute actions in order, but it must retain the fragment address at every step.
- **Use path-only or floating includes: rejected.**
  A shared file can change between authoring and replay.
  Digest pinning makes the change a preflight decision, not a hidden behavior change.
  `--update` cannot become a package manager.
- **Build a second shared replay engine: rejected.**
  ADR 0015's direct typed Maestro engine already owns its control semantics and performance contract.
  If the engines share only composition identity and provenance, both engines get one contract without duplicate dispatch, polling, or matching.
- **Automatically heal a stale or divergent fragment: rejected.**
  ADR 0012 retired unattended rewriting because selector agreement is not proof of target identity.
  Re-recording remains an explicit author action until a fragment-specific repair contract exists.

## Validation and implementation sequence

This spike adds no executable implementation or regression test, because it changes no runtime behavior.
The current codec, source-bundle, plan-digest, and Maestro include tests were audited.
The audit anchors the seams that the implementation must preserve.
The implementation must arrive in independently reviewable slices.
Every new structural gate must be observed to fail against a planted violation before the production change is trusted.

The audited seam tests are:

- `packages/ad-script/src/internal/__tests__/script.test.ts`
- `packages/ad-replay/src/internal/__tests__/plan-digest.test.ts`
- `packages/replay-port/src/__tests__/script-source-bundle.test.ts`
- `packages/maestro/src/internal/__tests__/replay-plan.test.ts`
- `packages/maestro/src/internal/__tests__/source-closure.test.ts`
- `packages/maestro/src/internal/__tests__/program-loader.test.ts`
- `packages/daemon/src/sessions/__tests__/replay-runtime/session-replay-runtime.test.ts`

The planted-red checks below are unit or fixture assertions.
The slice that introduces each check owns it.
They are not a claim that this docs-only spike already has a structural gate.

The current generic-dispatch seam is `resolveGenericRuntimeExecution` in `packages/daemon/src/execution/generic-runtime-execution.ts`.
Its completeness test does not prove the proposed old-reader fragment contract.

1. **Shared pure model and canonical fixtures.**
   Add typed composition nodes, fragment identity, invocation paths, local addresses, digest canonicalization, cycle/depth/size validation, and preflight result types without dispatch.
   Fixtures must prove these properties:
   - Two invocations share a digest but not an address.
   - A sibling include insertion does not change an unaffected local address.
   - A child edit changes the composition digests of all and only its transitive callers.
   - Source paths are diagnostics, not hidden global ordinals.
   - Ordinary comments, whitespace, timestamps, device names, and absolute source paths that the canonicalization rules exclude leave `fragmentDigest` unchanged.
   - Repeated logical steps get distinct control paths.
   - A nonzero iteration path is reported but refused for v1 resume.

   Plant a missing address/digest edge.
   Verify that the unit gate names it before you restore the implementation.

2. **Native fragment codec and source closure.**
   Extend the `.ad` codec with these items:
   - the first-executable `fragment-v1`/`composition-v1` guards;
   - the pinned reference and the include control;
   - lifecycle admission;
   - parse/write/parse round trips;
   - relative source resolution;
   - old-reader guard behavior.

   Extend the caller-side source bundle to ship the complete closure and execute the exact verified bytes.
   Before you expose capture, classify every existing descriptor that is allowed in a fragment.
   Plant each of these: a missing digest, a duplicate or missing `callSiteId`, and an admitted `open`.
   Then pass a guarded composition that contains `composition-v1`, `open`, and `include` to the old reader.
   Observe that the guard fails before the `open` handler.
   Separately, fixture an unguarded legacy script with a known prefix before an unknown command as explicitly out-of-scope behavior.
   Do not use it as v1 safety evidence.
   Also test the `fragment_composition_required` refusal of the new reader for a direct fragment replay.

3. **Capture and publication.**
   Add the explicit fragment capture aggregate and session commands.
   Reuse the existing recorder/evidence/parameterization and atomic writer seams.
   Test these behaviors:
   - the automatic verified entry guard;
   - identity-empty/ambiguous refusal;
   - no `open`/`close`;
   - retry after target collision;
   - abort without a file;
   - close after abort without a stranded claim;
   - a real saved body whose first local step is the guard.

   Plant a guardless fragment, an `open` body, an undeclared command, and overlapping ordinary-publication/repair transactions.
   Prove that each gate fails in the intended direction.

4. **Native composed replay and address-aware resume.**
   Resolve and verify the full graph before step 1.
   Execute nested invocations in parent order without flattening identity.
   Publish local addresses in progress, traces, and divergence.
   Require the matching composition digest for resume.
   Test these behaviors:
   - repeated/nested invocation paths;
   - stale child refusal;
   - entry-guard mismatch;
   - an inserted earlier include that leaves later local addresses unchanged;
   - root addresses;
   - `fragment_context_mismatch`, `fragment_variable_unbound`, and the `fragment_repair_unsupported` refusal.

   Test that an address resume at an invocation boundary reruns guards.
   Test that a mid-body fragment resume is rejected.
   Test that only stable address fields are compared, and that source lines are reported diagnostically.
   Keep flat-script `--from N` tests unchanged.
   Plant a global-index-only report and a numeric resume against a native composed plan.
   Both must fail the unit gate.
   Include a cold-replay smoke fixture with a root `open`, a pinned `include`, and a root `close`.
   Thus the same parent artifact that the address assertions use exercises the lifecycle boundary.

5. **Maestro integration below the typed interpreter.**
   Adapt the existing source-preserving `runFlow` plan/interpreter to emit the shared invocation/provenance/digest records.
   Retain scoped env, conditions, runtime controls, and its loader.
   Extend the existing include/source provenance and conformance tests.
   Assert that file-backed `runFlow` uses the existing compiled-plan digest when an expected digest is supplied.
   Assert that inline and skipped controls retain their typed semantics.
   Test derived call-site/control identities, repeated and retrying execution paths, and their nonzero-iteration resume refusal.
   Do not route Maestro through native `.ad` parsing or a recursive daemon replay switch.
   Plant a flattening adapter, and verify that the source/address test catches it.

6. **Provider and live validation.**
   Add provider-backed record → publish → compose → cold-replay scenarios.
   Add stale-edit refusal before device work and repeated-fragment address reporting.
   Add iOS plus Android evidence for real entry guards and lifecycle ownership.
   The existing fixture tests prove contracts only.
   They do not replace the live device evidence that a merge-ready implementation requires.
   Both iOS and Android evidence rows must be green to complete this slice and release the cross-platform public fragment/composition surface.
   If one lane is unavailable, the implementation remains incomplete.
   Report the gap with the exact failing precondition and the captured typed error/details.
   The gap is residual live-device/OS evidence, not a code failure.
