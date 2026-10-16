# ADR 0020: Composable Recorded Fragments

## Status

Proposed design spike for [#1336](https://github.com/callstack/agent-device/issues/1336).
This ADR defines the proposed artifact and ownership contract.
Implementation remains later work in a separately reviewable sequence.

## Context

The E3 repair-economics matrix found re-recording less expensive than agent repair for two cases:

- Label drift: $1.21 versus a $2.34 repair median
- Cascade drift: $1.55 versus $2.05

Repair won only for one diverged read, at $0.69.
That figure is a repair-only baseline.
Only the label/cascade rows compare re-recording costs.
Thus, re-recording is the repair method, and its unit determines reuse costs.
If thirty flows share login, one reusable fragment should replace thirty closed scripts.

Current native `.ad` recordings are closed units.
`open` establishes their session; `close` terminates it.
ADR 0016 limits publication to open-to-destination scripts and reserves arbitrary slices for this decision.
Target evidence comes from action-time capture and cannot be reconstructed from history.
ADR 0012 shows the cost of lost provenance.
A flattened Maestro include shifted ordinals and obscured divergence attribution and the included line table.
ADR 0015 now requires a source-preserving typed Maestro interpreter.
It owns `runFlow`, scopes, conditions, repeats, retries, and include loading.

The design must satisfy four boundaries:

- A fragment cannot conceal session lifecycle.
- The first action must prove the entry screen.
- An edit must invalidate exactly the compositions that use the fragment.
- Failure must identify a local step and invocation, rather than an expanded global ordinal.

## Rules at a glance

This ADR proposes these rules:

1. **Native fragments have no lifecycle.** The parent owns `open`, context, launch state, session ownership, and `close`.
   A native fragment contains neither `open` nor `close`.
   Invocation never relaunches or terminates the session.
   Maestro subflows retain ADR 0015 typed-flow lifecycle semantics.
2. **Capture is explicit and entry-guarded.** `session fragment start <path> --entry <selector>` captures a verified landmark as its first recorded `wait`.
   `session fragment save` publishes without session closure.
   Later history slicing is unsupported.
3. **Composition shares semantics across two engines.** Native `include` and Maestro `runFlow` share invocation boundaries, provenance, addresses, and structured failures.
   Format-owned parsers/interpreters retain identity, digest, lifecycle, and execution semantics.
   Neither format converts the other into another replay engine.
4. **Native references require digest pins.** Each persisted include has a relative locator and the expected digest resolved at authoring.
   Missing, changed, cyclic, or unsupported fragments fail preflight before device action.
   Maestro retains its source-preserving loader and compiled-plan digest without native comment syntax.
   Native artifacts have no implicit latest-version fallback or silent repin.
5. **Addresses are owner-local.** They use fragment/root composition digest, invocation/control paths, and local ordinal.
   `source.path:line` remains diagnostic.
   Optional bounded `displayOrdinal` never authorizes resume or enters an address.
6. **Existing target evidence applies.** Entry guards and actions use ADR 0012 `target-v1`/`targets-v1` verification.
   V1 native fragments/parents require first-executable `fragment-v1`/`composition-v1` guards.
   New readers consume guards during preflight.
   Old readers reject the unknown action before root `open` or a known prefix.
   Other metadata/references remain reserved comments that older readers ignore.
7. **Native repair requires explicit re-recording.** `replay --save-script` never flattens composition into one healed script.
   Until fragment-specific repair exists, callers re-record the fragment and explicitly repin parents.
   Maestro retains its existing unsupported-`--save-script` behavior.

## Decision

### Fragment artifact and lifecycle ownership

This section proposes a portable v1 `.ad` body without session lifecycle.
A required first-executable guard identifies its format.
The conceptual shape is:

```text
fragment-v1
context platform=ios target=mobile
# agent-device:target-v1 {"id":"home","role":"heading","label":"Home","ancestry":[],"sibling":0,"viewportOrder":0,"verification":"verified"}
wait "id=\"home\""
click "label=\"Continue\""
```

Future implementation defines exact writer syntax.
This proposal fixes these invariants:

- **Format and context:** `fragment-v1` is the required first-executable format guard.
  New source preflight consumes it as an envelope, not a `SessionAction`.
  It has no device side effect.
  Native parents start with `composition-v1`, before root `open` or `include`.
  Older readers parse either guard as an unknown action.
  `dispatchKnownCommand` returns `INVALID_ARGS` before a platform handler.
  Fragments contain no `open`, `close`, or concealed launch action.
  Writers always emit effective `context platform` and `target`.
  Parsers reject a missing constraint.
  These values constrain effective context without device selection or session creation.
  The parent supplies those facts.
- **Entry guard:** the first executable step is a selector `wait` with `target-v1` and `verification: "verified"`.
  Its identity-bearing evidence and guard enter the fragment digest.
  Existing landmark polling and identity semantics apply.
  It is neither a screenshot fingerprint nor an approximate label check.
  Timeout uses the exact existing `wait` positional budget.
  `start` accepts an optional entry-timeout.
  If omitted, capture resolves the current selector-runtime default once and records that concrete millisecond value.
  Future default changes therefore neither affect published behavior nor invalidate digests.
- **Existing codecs:** the body uses recorded-action codecs, selector-chain optimization, target evidence, and ADR 0017 parameterization.
  It introduces no second annotation format or fragment matcher.
- **Admission:** descriptors and recording traits determine permitted commands.
  The writer must not duplicate a manual list for lifecycle, device ownership, publication, or other resource-owning commands.
  A positive fragment-safe descriptor trait forms the allowlist.
  An undeclared command is refused before activation or replay.
  Future commands cannot become safe by omission.
  During armed capture, refusal precedes dispatch and leaves capture armed for retry.
  Replay preflight rejects the complete invalid plan.
  Before the new surface is enabled, implementation must classify every supported recording command.
- **Scope:** invocations inherit effective session, context, and late-bound native `${VAR}` scope.
  Preflight enumerates referenced names and refuses missing bindings with `fragment_variable_unbound`.
  Values never expand into the digest.
  V1 has no invocation arguments, output-variable contract, or local variable shadowing.
  Existing script/header/shell inputs supply one inherited flat scope.
  Maestro keeps ADR 0015 typed `runFlow` environment and output scopes.

The **session** owns the live device and app.
A separate **fragment capture aggregate** owns buffer, entry guard, target path, and `ARMED`/`PUBLISHED`/`ABORTED` publication state.
It creates no second session lifecycle or synthetic `close`.
The ordinary action log continues beside its buffer.
Only ordinary script-publication and ADR 0012 repair transactions are mutually exclusive with fragment capture.
Concurrent publications would obscure ownership and provenance.

While armed, a new session/open or ordinary recording/repair transaction fails before platform dispatch.
The reason is `fragment_capture_conflict` with `{sessionState: "fragment_armed", conflictingOperation}`.
Lifecycle `open` and `close` cannot enter the fragment body.
A session-ending `close` instead aborts capture without publication, then closes normally and releases the device claim.
Client disconnect or lease expiry also aborts capture.
`save` and explicit `abort` leave the underlying session active.

The action log remains available for diagnostics and ordinary history.
After fragment activation or publication, that session is ineligible for ordinary open-to-destination publication.
A later ordinary publication returns `fragment_capture_conflict` with fresh-session guidance.
This prevents silent duplicate publication of the journey as a fragment and an unmarked closed script.

### Recording UX: start at the boundary, never slice after the fact

This section proposes an explicit in-session authoring boundary:

```sh
agent-device session fragment start ./fragments/login.ad --entry 'id="Home"'
# perform the reusable login journey with ordinary commands
agent-device session fragment save
```

`--entry` is a portable selector, never a session-local `@ref`.
Start resolves it against the current observation.
It records an equivalent `wait` with fresh `target-v1` as local step 1.
Before activation, start refuses absent, ambiguous, identity-empty, or otherwise unverifiable landmarks.
The author supplies an explicit entry precondition; the artifact receives the guard automatically.
Callers may abort and retry in the same live session.
The writer cannot infer screen identity from a snapshot or history range.

`save` uses the path fixed by `start`.
It reuses same-directory atomic publication and the script writer's no-clobber default.
There is no alternate save destination.
A destination change requires abort and restart.
Target collision, serialization failure, or invalid body leaves capture armed for retry.
Only successful save reaches `PUBLISHED`.
`--force` explicitly authorizes replacement.
A new body at the old path makes existing digest pins stale.
Versioned paths are therefore recommended for shared fragments.
Interrupted or aborted capture publishes no partial file.

This is not a later slice of `session.actions`.
ADR 0012 evidence depends on the resolution-time tree and cannot reliably be reconstructed after navigation.
Existing active-session publication remains open-to-destination.
Fragment capture has its own explicit boundary and first-step guard.

### One composition model below two interpreters

This section proposes a small shared **composition/provenance model**, not a replay VM.
Both engines use its semantic records:

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

The model owns only shared facts:

- Fragment identity and digest dependencies
- Invocation boundaries, lifecycle ownership, and inherited scope identity
- `FragmentStepAddress` construction and source provenance
- Missing/stale/cyclic/unsupported fragment preflight errors
- Structured failure projection with local addresses

It does not own selector matching, platform dispatch, Maestro conditions, repeat/retry polling, or native parsing.
Native parsing recognizes `include` and creates a nested invocation node.
Maestro retains `runFlow` in its source-preserving typed IR/interpreter.
Child loads contribute the same invocation/provenance records.
Maestro owns `runFlow` controls, scoped variables, optional behavior, and runtime repeats under ADR 0015.
Sharing the model prevents duplicate semantics without transferring interpreter ownership.

A composed native parent requires `composition-v1` before root `open` or any `include`.
Flat scripts without includes retain existing format and behavior.
New preflight consumes the guard without device action.
Old readers fail at the format boundary before partial execution.

V1 permits no cross-format includes.
Native `include` loads native fragments; Maestro `runFlow` loads Maestro programs.
Neither parser interprets the other's syntax.

Pin syntax remains format-specific.
Persisted native includes must have a `fragment-ref-v1` expected digest.
File-backed Maestro `runFlow` contributes child source closure and existing compiled-plan digest to shared identity/provenance.
With an expected Maestro plan/composition digest, changed closure causes the same preflight stale failure.
Without an expected digest, ADR 0015 deliberately loads current closure and produces its new identity.
This does not authorize floating native references.
Inline `runFlow: commands:` remains a typed control node, not a file-backed fragment.
It has no locator or standalone fragment address.
Skipped conditional invocations create no child invocation or iteration ordinal.
Only executed iterations receive ordinals.

Native entry, admission, and lifecycle-free rules apply only to recorded `.ad` fragments.
Maestro keeps typed preconditions and may contain its own lifecycle/control commands.
The shared model records boundaries and provenance without conversion to native bodies.

Maestro derives shared identities from typed IR without new YAML fields.
Its `runFlow` call-site ID hashes these inputs with a format tag:

- Canonical typed node
- Resolved source-bundle-relative locator
- Local occurrence among otherwise identical siblings

`repeat`/`retry` control IDs use the same rule.
Source lines and expanded ordinals are excluded.
These are internal compiled-plan identities, not author syntax.
Node or local-structure edits change the existing Maestro plan digest and invalidate old addresses.
Local occurrence only distinguishes identical authored siblings in one plan.
It is never a global step identity.
Maestro addresses are stable only within their matching compiled-plan digest.
An edit, including an earlier identical sibling, deliberately invalidates the old address.
Cross-edit call-site stability is not promised.

An include is a control boundary, not a `SessionAction`.
Its children execute and record within the parent's live session.
Planning, traces, failure reports, and digests retain the boundary.
Nested fragments require cycle detection and bounded source/depth policy shared with Maestro source-bundle limits.

### Pinned references, fragment digests, and staleness

This section proposes a reserved native reference comment immediately before `include`:

```text
# agent-device:fragment-ref-v1 {"callSiteId":"login-entry","digest":"sha256:<64 lowercase hex>"}
include "./fragments/login.ad"
```

The caller-side source bundle resolves paths relative to the including source.
Required `callSiteId` persists the authored include occurrence's identity.
The writer preserves it for in-place edits and assigns a new value to a new occurrence.
It must be unique within its parent.
Missing/duplicate values cause preflight `fragment_call_site_invalid`.
The digest identifies the fragment.
The path is only a locator and provenance hint.
Future implementation may choose equivalent inline syntax.
It must preserve call-site identity, locator, and digest.
It must not accept unpinned native includes in persisted composition.

`fragmentDigest` is SHA-256 over canonical parsed-fragment JSON with these inputs:

- Format/canonicalization version
- Effective platform/target constraints
- Verified entry guard
- Normalized executable commands, inputs, execution-affecting flags/runtime hints, and `target-v1`/`targets-v1`
- Nested pinned references, `callSiteId`, and child digest

A native parent's reference IR includes authored relative locators, never resolved absolute paths.
An unchanged child move keeps its digest but requires an explicit parent locator edit and parent repin.
Session timestamps, device names, absolute source paths, and ordinary comments are excluded.
Native `${VAR}` placeholders remain unresolved, as ADR 0012 requires.
Maestro retains effective static environment and parse-time expansion in its ADR 0015 digest.
Target annotations affect digests because they affect verification during execution.
They are not merely diagnostic text.

Shared identity is `(format, digest)`.
Native and Maestro languages need not produce equal hashes.
Each format retains its canonical JSON implementation and versioned identity input.
The model compares typed identities and dependency edges.
Format-owned parsers define canonicalized bytes.

`compositionDigest` hashes the canonical root, ordered include semantics, and transitive graph of **pinned expected** identities.
It does not hash unrelated directory or source-bundle files.
A valid digest requires complete closure resolution and matching expected digests for the bytes to execute.
A changed leaf immediately invalidates direct callers.
An ancestor's own digest changes only after its pin is explicitly updated.
That parent repin then invalidates the next caller.
This deliberate bottom-up process can require N levels.
Unreferenced fragments do not affect callers.
Renamed `callSiteId` changes canonical IR and requires the same explicit upward repin as an execution-affecting edit.

Before step 1, preflight resolves and verifies the complete source closure.
Parsing, digest calculation, and execution consume the resolver's same verified bytes.
No second filesystem lookup can substitute unchecked content.
These conditions fail without device or session side effects:

- Missing pinned source-bundle file
- Actual/expected canonical digest mismatch
- Unsupported format/canonicalization version
- Include cycle or exceeded source/depth/size bound
- Lifecycle or entry-guard admission violation
- Platform/target incompatibility with effective parent context
- Unbound inherited native variable

Source validation uses ADR 0010's `INVALID_ARGS` family with these machine reasons:

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

Details include including source, locator, expected digest, actual digest when available, and call-site.
Agents branch on `details.reason`, never messages.
Preflight never loads latest implicitly, rewrites parents, or executes a valid prefix before stale-child discovery.
ADR 0012 `--update` remains no-write suggestions and cannot repin.

Request-state/artifact-kind validation also uses `INVALID_ARGS` but has a separate details contract:

| Reason | Details |
| --- | --- |
| `fragment_resume_mismatch` | Expected/current composition identity |
| `fragment_resume_unsupported` | Expected/current composition identity |
| `fragment_composition_required` | Artifact kind/source |
| `fragment_capture_conflict` | Session state/conflicting operation |
| `fragment_repair_unsupported` | Command and format |

These errors do not invent source locator/digest details.
Capture conflict concerns same-session transactions.
`DEVICE_IN_USE` remains for devices claimed by another session.

Preflight selects the first applicable reason in this total order:

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

A stale child fails before a composition digest exists.
A resume against that closure reports `fragment_stale`, not `fragment_resume_mismatch`.
After valid digest construction, request checks report mismatched expected identity as `fragment_resume_mismatch`.
Unsupported resume shape reports `fragment_resume_unsupported`.
Direct fragment replay without a parent reports `fragment_composition_required` outside closure ordering.

### Stable addressing, divergence, and resume

This section proposes local addresses for every executable fragment step.
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

`localStep` is the owner's 1-based logical executable ordinal, including the entry guard.
`invocationPath` combines persisted include `callSiteId` and explicit runtime invocation ordinals.
Source path/line is diagnostic only.
`controlPath` adds persisted typed-control identities and runtime iteration/attempt ordinals for format-owned controls, including repeat/retry.
Every addressable repeat/retry requires an owner-unique `controlId`.
Missing/duplicate values cause `fragment_control_identity_invalid`.
The path distinguishes repeated executions of one logical step.
It is empty in native fragments without those controls.
Neither path is an expanded global-array position.

Two invocations share the fragment digest but have different invocation paths.
An earlier inserted fragment does not renumber later local steps or change their authored call-site identities.
Fragment edits change its digest and deliberately invalidate old addresses.

Root owner is `{kind: "root", format, compositionDigest}` with empty `invocationPath` and 1-based logical root `localStep`.
Any composition-digest change invalidates root addresses.
Fragment addresses depend on both fragment and enclosing composition identity.
Only these fields affect equality or resume authorization:

- `address.version`
- `owner`
- `invocationPath.callSiteId`
- `invocationPath.iteration`
- `controlPath.controlId`
- `controlPath.iteration`
- `localStep`

Sibling `provenance` is display/diagnostic data and never authorizes resume.
Comment/format edits can change lines without changing a valid address within the same published composition.

Runtime iteration/attempt values record execution evidence, not independent identity.
Divergence and tracing emit them.
V1 address-aware resume accepts only all-zero iteration/attempt paths with statically reachable controls.
Nonzero or runtime-conditional paths cause `fragment_resume_unsupported`.
A matching digest cannot reconstruct executed dynamic iterations.

Flat scripts retain ADR 0012 `step.index`, `--from N`, and `--plan-digest` unchanged.
Native composed plans add root/fragment `step.address` and `resume.address`.
Address-aware resume requires matching `compositionDigest`.
Optional bounded `displayOrdinal` supports display/progress only.
It never enters addresses or authorizes resume.
Future native CLI/Node/MCP syntax may use existing `--from` or an additive opaque token.
It must not require callers to infer a repeated fragment's flattened index.
Until address-aware resume exists, native composition rejects numeric `--from`.

Maestro retains its existing numeric `from` plus `planDigest` contract as its typed-interpreter implementation adds shared address fields.
This ADR removes no working Maestro surface.
YAML continues to reject `--save-script` with its existing format error.
ADR 0012 repair recording applies only to native `.ad`.
Native repair/address rules do not apply retroactively to Maestro.

V1 address-aware resume permits composed root steps and fragment boundaries (`localStep: 1`) only.
Later fragment steps still require addresses for traces, progress, and divergence.
Their resume returns `fragment_resume_unsupported`.
The entry guard is an entry precondition, not a persistent screen invariant.
Repeating it after prior fragment actions would be incorrect.
Per-step preconditions or a safe prefix require a future ADR.
A local address alone does not prove mid-body device state.
At nested boundaries, only the target fragment's local-step-1 guard runs.
Ancestor steps and guards do not repeat because callers own skipped parent state.
The target invocation counts local step 1 once.

For root resume, callers supply state for skipped actions under the existing flat contract.
A matching digest proves plan identity only.
Root steps have no fragment guard.
A root address does not prove device state.

Fragment target-binding/action failures retain ADR 0012 `REPLAY_DIVERGENCE`, bounded screen, repair hint, and structured cause.
Step provenance adds fragment digest, invocation/control paths, local step, and source path/line.
Include-load/validation failures instead name the include call-site during preflight.
No projection may reduce fragment failure to a parent global ordinal.

### Annotation compatibility and versioning

This section proposes versioned format, reference, canonicalization, and address boundaries.
`fragment-v1`/`composition-v1` are executable guards, not comments or target annotations.
`# agent-device:fragment-ref-v1` remains a reserved comment.
Entry `wait` and every element-targeting action retain existing `target-v1`/`targets-v1` evidence.
Existing size limits, canonical field order, and fail-closed `verification` apply.
Older readers ignore unknown reference comments but reject unknown executable guards at the format boundary.

New readers consume guards during source preflight.
Older readers parse them as actions.
`dispatchKnownCommand` in `src/core/dispatch.ts` throws `INVALID_ARGS` before the platform handler.
Root `open`, known prefixes, and expanded children therefore cannot execute.
Unguarded legacy `.ad` retains existing behavior, including known-prefix execution before a later unknown command.
That case is outside v1 acceptance and supplies no safety evidence.
New readers refuse direct fragment replay with `fragment_composition_required`.
Future unknown reference comments remain ignorable.
Future unknown executable guards fail before device work.

`src/core/__tests__/dispatch-keyboard.test.ts` does not prove unknown-command rejection.
Implementation must add planted-red tests through the old dispatch path.
A guarded composition containing `open` must fail before its handler.
A separate legacy-prefix fixture remains explicitly outside scope.
Strict reserved-header/reference tests are also required.
This ADR does not claim that these tests exist.

Format, canonicalization, and address-shape changes are breaking boundaries.
Readers must not reinterpret v1 digests with another canonicalizer.
Minor additive annotations may remain ignored comments only if they preserve the v1 execution contract, under ADR 0012.
Lifecycle, entry-verification, or digest-meaning changes require a new version and explicit migration.
Versions govern these contracts:

- Fragment/composition guard: body grammar
- Reference: pinned-reference schema
- Address: wire shape
- Canonicalization: digest input

Any mismatch causes preflight `fragment_unsupported`.

### Repair and migration boundaries

This proposal deliberately excludes these implementation features:

- Automatic extraction from existing scripts or arbitrary history
- Fragment parameters or output variables
- Registry/content-addressed remote stores
- Cross-format includes
- Silent repins
- Automatic versioned names
- `--update` writes
- Fragment-aware `replay --save-script` repair

Closed `.ad` and ADR 0016 open-to-destination scripts retain byte/behavior compatibility.
Migration starts fresh capture at an explicit boundary with a stable entry selector.
The author publishes a new path and adds a digest-pinned parent include.
Existing scripts are neither rewritten nor inferred to be fragments.
Ordinary recording and ADR 0012 repair retain separate lifecycles.
They refuse overlap with fragment capture instead of producing hybrid artifacts.

After fragment divergence, the agent must repair app state or explicitly re-record that fragment and update its parent pin.
A future repair ADR may reuse agent-supervised “heal-by-doing”.
It must publish a guarded fragment body and preserve its digest boundary.
It may not flatten composition as fallback.
Until that contract exists, native composed `replay --save-script` returns `fragment_repair_unsupported`.
It never emits root-only or flattened replacements.

Authors repin changed dependencies explicitly from leaf to root:

1. Publish the changed child.
2. Update each direct include and republish its parent.
3. Repeat for direct callers until the root is current.

Each operation is a deliberate file edit or future dedicated tool operation.
Replay never writes pins.
Preflight reports dependency chains and remaining stale ancestors.
This v1 tradeoff exposes stale reuse instead of implicit multi-flow changes.

## Consequences

If implemented, the proposal would have these consequences:

- Shared login/navigation becomes one reviewable, re-recordable artifact.
  Parents retain setup and teardown ownership.
- Entry guards add one bounded wait and identity capture during authoring.
  They prevent silent action on an incorrect entry screen.
- Edits make every pinned caller explicitly stale.
  Repin work replaces silent changes to thirty flows.
- Flat inherited scope cannot give two invocations independent variable sets.
  Until a parameter contract is accepted, callers must use separate parent scopes or separately authored fragments.
- Captured platform/target makes v1 fragments context-specific.
  Cross-platform journeys require separate recordings and pins.
- Bundles/preflight carry the transitive closure.
  Content identity remains independent of absolute local paths.
- Local steps/control paths remain stable when unrelated siblings are added or expanded.
  Address-aware resume is explicit at roots and fragment boundaries.
  Mid-body resume remains refused without state preconditions.
  Global indices cannot safely approximate these rules.
- Fragments are not standalone tests.
  Parents own `open`/`close`; fragment work introduces no concealed lifecycle.

## Alternatives considered

This proposal evaluates these alternatives:

- **History slicing: rejected.** The recorder no longer has the action-time tree for ADR 0012 evidence or entry proof.
  It repeats ADR 0016's rejected late-publication problem.
- **Lifecycle inside every fragment: rejected.** Relaunch or teardown affects the caller's session and prevents safe shared login invocation.
- **Infer entry from screenshots, snapshots, or last action: rejected.** Screen identity is application semantics.
  A caller-selected identity-bearing landmark reuses verified `wait` instead of a new cross-platform fingerprint.
- **Flat global expansion: rejected.** ADR 0012's Maestro incident shows shifted ordinals and lost source boundaries.
  Ordered execution must retain each step's fragment address.
- **Path-only/floating includes: rejected.** Files can change after authoring.
  Digest pins expose changes during preflight rather than silently changing behavior.
  `--update` cannot become a package manager.
- **Second shared replay engine: rejected.** ADR 0015's typed engine owns Maestro controls and performance.
  Shared identity/provenance avoids duplicate dispatch, polling, or matching.
- **Automatic fragment repair: rejected.** ADR 0012 retires unattended rewrites because selector agreement does not prove identity.
  Re-recording remains explicit until a fragment-specific contract exists.

## Validation and implementation sequence

This proposal adds no executable implementation or regression test because runtime behavior does not change.
Audits of current codecs, source bundles, digests, and Maestro includes identify boundaries to preserve.
Implementation must use independently reviewable parts.
Before trusting each new structural gate, observe its failure against a planted violation.

Audited tests are:

- `packages/ad-script/src/internal/__tests__/script.test.ts`
- `packages/ad-replay/src/internal/__tests__/plan-digest.test.ts`
- `packages/replay-port/src/__tests__/script-source-bundle.test.ts`
- `packages/maestro/src/internal/__tests__/replay-plan.test.ts`
- `source-closure.test.ts`
- `program-loader.test.ts`
- `packages/daemon/src/sessions/__tests__/replay-runtime/session-replay-runtime.test.ts`

Each implementation part owns its planted-red unit/fixture assertions below.
This docs-only spike does not already have those structural gates.
`src/core/dispatch.ts` owns old-reader rejection.
The current keyboard-dispatch test supplies no evidence for it.

1. **Pure model and canonical fixtures.** Add composition nodes, identities, invocation paths, local addresses, canonicalization, cycle/depth/size validation, and preflight result types without dispatch.
   Fixtures must prove these properties:
   - Two invocations share a digest, but not an address.
   - Sibling insertion preserves an unaffected local address.
   - Child edits change all and only transitive callers' composition digests.
   - Source paths are diagnostic, never hidden global ordinals.
   - Excluded comments, whitespace, timestamps, device names, and absolute paths preserve `fragmentDigest`.
   - Repeated logical steps have distinct control paths.
   - Nonzero iteration paths are reported but refused for resume.
   Plant a missing address/digest edge.
   Verify the gate names it before restoring implementation.
2. **Native codec and closure.** Add executable guards, pinned references, includes, lifecycle admission, codec round trips, relative resolution, and old-reader behavior.
   Extend source bundles to carry complete closure and execute exactly verified bytes.
   Classify every admitted descriptor before capture exposure.
   Plant missing digests, duplicate/missing `callSiteId`, and admitted `open`.
   Give the old reader a guarded parent with `composition-v1`, `open`, and `include`.
   Observe refusal before the `open` handler.
   Separately fixture unguarded known-prefix execution as out of scope, never v1 evidence.
   Test new-reader `fragment_composition_required` for direct replay.
3. **Capture and publication.** Add the aggregate/session commands through existing recorder, evidence, parameterization, and atomic writer boundaries.
   Test automatic verified guards, identity-empty/ambiguous refusal, no lifecycle commands, collision retry, abort without files, and close after abort without stranded claims.
   A real saved body must start with its local guard.
   Plant guardless bodies, `open`, undeclared commands, and overlapping ordinary/repair transactions.
   Prove each intended gate fails.
4. **Native composition and address resume.** Verify the full graph before step 1.
   Execute nested invocations in parent order without flattening identity.
   Include local addresses in progress, traces, and divergence.
   Require matching composition digests for resume.
   Tests cover repeated/nested paths, stale children, guard mismatch, and unchanged later local addresses after earlier includes.
   Also test roots, `fragment_context_mismatch`, `fragment_variable_unbound`, and `fragment_repair_unsupported`.
   Boundary resume must run guards; mid-body resume must refuse.
   Compare only stable fields and retain diagnostic lines.
   Flat `--from N` tests remain unchanged.
   Plant global-index-only reports and numeric composed resume; both must fail the unit gate.
   One cold-replay fixture must combine root `open`, pinned `include`, and root `close` with the same address assertions.
5. **Maestro typed-interpreter integration.** Add shared records beneath existing source-preserving `runFlow` without changing scoped env, conditions, runtime controls, or loader.
   Extend include/source provenance and conformance tests.
   File-backed expected digests use the existing compiled-plan digest.
   Inline/skipped controls retain typed semantics.
   Test derived identities, repeat/retry paths, and refusal of nonzero-iteration resume.
   Do not use native parsing or recursive daemon replay switches.
   Plant a flattening adapter and prove source/address tests detect it.
6. **Provider and live validation.** Add provider record → publish → compose → cold-replay scenarios.
   Cover stale-edit refusal before device action and repeated-fragment addresses.
   Obtain iOS and Android evidence for real guards and lifecycle ownership.
   Fixtures prove contracts but cannot replace required live evidence.
   Both platform rows must pass to complete this part and release the cross-platform surface.
   If a lane is unavailable, implementation remains incomplete.
   Report its exact failing precondition and captured typed error/details.
   That gap is residual device/OS evidence, not a code failure.
