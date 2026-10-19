# ADR 0017: Parameterized Recorded Inputs

## Status

Accepted

## Rules at a glance

- The fill-only `recordAs` input parameterizes a recorded fill value.
  The CLI spells it `--record-as <VAR>`.
- The live fill dispatch receives the literal.
  The public response, recording state, and published script of the fill use `${VAR}`.
  The session event hides the fill value as `<text>`.
- Variable names use replay's uppercase `[A-Z_][A-Z0-9_]*` grammar.
  `AD_*` remains reserved for runtime built-ins.
- `--record-as` is rejected unless script recording is armed.
  `--record-as` cannot be combined with `--no-record`.
- Sensitivity is never inferred from a selector, label, field name, or value shape.
  The caller names each mapping explicitly.
- If replay dispatches an authored fill whose complete text token is a `${VAR}` placeholder, replay derives `recordAs=VAR`.
  Thus, a replay that is recorded or repaired retains the original placeholder.
  Embedded interpolation remains ordinary script input.
- For the lifetime of one recording session, no later recorded action's own result payload or `target-v1`/`targets-v1` identity evidence may re-serialize an app-rendered echo of an already-parameterized literal (#1398).
  The explicit scope limits of the #1398 amendment apply.
- Unparameterized fill/type values remain literal script content.
  An author's own explicitly typed selector or positional text is not scanned.

## Context

Ordinary `.ad` recording persists executable inputs.
A literal `fill` value therefore becomes part of the published script.
This includes any password or token supplied during authoring.
Diagnostic and event redaction cannot make that executable artifact safe, because replay still needs the value.

Native replay already resolves `${VAR}` from `--env`/`-e` and `AD_VAR_*` immediately before dispatch.
The missing boundary is authoring.
The live app needs the literal, while recording state and every publication write must receive only the placeholder.
Issue [#1348](https://github.com/callstack/agent-device/issues/1348) defines this requirement.
ADR 0016's active-session publication deliberately excluded secret-bearing journeys until #1348 was solved.

## Decision

Add a fill-only `recordAs` input.
The CLI spells it `--record-as <VAR>`.
The Node and MCP fill contracts expose it as `recordAs`:

```sh
export AD_VAR_PASSWORD='<secret>'
agent-device open com.example.app --save-script=login.ad
agent-device fill 'id="password"' "$AD_VAR_PASSWORD" --record-as PASSWORD
agent-device wait 'role="heading" label="Home"'
agent-device session save-script
```

The live fill dispatch receives the literal.
Its public response, recording state, and published script use `${PASSWORD}`.
The session event hides the fill value as `<text>`.
Later, replay resolves the placeholder from `AD_VAR_PASSWORD` or `--env PASSWORD=<value>` before the fill is dispatched.

Variable names use replay's uppercase `[A-Z_][A-Z0-9_]*` grammar.
`AD_*` remains reserved for runtime built-ins.
`--record-as` is rejected unless script recording is armed.
`--record-as` cannot be combined with `--no-record`.
Ordinary fills without the option keep literal recording behavior.
Sensitivity is never inferred from a selector, label, field name, or value shape.

### Mapping contract

The caller names the mapping explicitly.
Reuse of `PASSWORD` deterministically emits `${PASSWORD}`.
Use of `API_TOKEN` emits `${API_TOKEN}`.
There is no secret-to-name table and no literal comparison or deduplication state.
This rule avoids the retention of a second copy of the secret.
It also makes distinct-value naming an authoring decision that is visible in the script.

### Data-flow boundary

The literal exists only on the live request path, and only long enough to execute the interaction:

1. Before platform work, the request scope registers the literal as an explicit diagnostics secret.
   This is in addition to key-name redaction, because an opaque value need not look secret.
2. The platform interaction receives the literal.
3. Before response/event/recording retention, the semantic `text` field of the fill result becomes `${VAR}`.
   Every occurrence in a post-fill `refLabel` is parameterized.
   Stable selector/ref provenance is preserved byte-for-byte.
   Untrusted backend extras and nested settle output parameterize every occurrence of the supplied literal in both keys and values.
   Post-fill selector-chain candidates are dropped only when a parsed `text`, `label`, or `value` term semantically contains the literal.
   Known response and settle schema fields are the explicit structural boundary, and they retain their names and provenance values.
   Inline whitespace replacement cannot distinguish a sensitive value from ordinary separators.
   Thus, an untrusted string or key that contains a whitespace-only literal collapses to the placeholder instead.
4. At `recordActionEntry`, the recorder reconstructs the literal positional of the fill and writes only the placeholder into `SessionAction`.
   The recorder parameterizes the semantic result field plus arbitrary backend/settle echoes again.
   ADR 0012 `target-v1` evidence keeps its structure.
   Exact value-bearing accessibility labels become the placeholder.
   Identity fragments that merely contain the same characters are not rewritten.
   The `recordAs` control flag itself is not serialized into the script.
   Parameterization is idempotent.
   This second pass preserves placeholders inserted at the response boundary, even when the literal is part of the variable name of the placeholder or is `$`.
5. The existing ADR 0012/0016 writer receives an already-parameterized action.
   Its selector provenance, portability checks, same-directory temp write, and atomic publication algorithm are unchanged.

The target and the temp file are written from the same prepared script string.
Thus, neither can contain the literal once this pre-publication boundary has run.

### Replay and repair

Missing variables retain replay's existing fail-loud behavior.
`${VAR}` resolution throws before the corresponding action is invoked.
If replay dispatches an authored fill whose complete text token is a `${VAR}` placeholder, replay's daemon-only provenance channel derives `recordAs=VAR` for that live request.
This derivation uses the unresolved source action, independently of whether the resolved value is empty or whitespace.
Thus, if the replay is itself being recorded or repaired, the recorder retains the original placeholder instead of serializing the expanded value.
Embedded interpolation remains ordinary script input.
Safe authoring emits one complete placeholder token.

### Session-scoped echo protection (amendment, #1398)

> **Status: accepted.** This amendment changes the data-flow boundary above from fill-step-scoped to recording-session-scoped, per issue [#1398](https://github.com/callstack/agent-device/issues/1398).

The boundary above protects only the request/recording path of the originating fill itself.
After [#1349](https://github.com/callstack/agent-device/issues/1349), a later read-only action records `target-v1` identity evidence and a result payload independently.
These read-only actions are `wait` with landmark-mode evidence, `is`, and `get`.
That capture comes from whatever the app renders at that later step.
The capture has no memory of the literal of an earlier fill.
Thus, an app-rendered echo of the literal can re-enter session state and publication through a completely different, unparameterized action.
This can occur even though the originating fill was parameterized.
Examples of such an echo:

- The displayed value of the filled field itself.
- A search result, validation message, or confirmation label that contains the literal.
- A destination landmark whose accessible label includes the literal.

**The guarantee is now recording-session-scoped, not fill-step-scoped.**
For the lifetime of one recording session, no later recorded action's own result payload or `target-v1`/`targets-v1` identity evidence may re-serialize an app-rendered echo of a literal that the session already parameterized.

The mechanism is the smallest explicit, ephemeral state that can recognize a later echo.
This state is `SessionState.recordedFillLiterals`, an in-memory `Map<literal, placeholder>`.
Only the SAME (literal, placeholder) pair that a `fill --record-as` entry already computes for its own boundary above populates the map.
The map gets one entry for each parameterized fill, added only after the entry of that fill itself has been recorded.
The map is never serialized: not to the script, the session event log, or diagnostics.
The map has no read API beyond the recorder that owns it.
The map disappears with the session.

This is not a reversal of the "no secret-to-name table" rule in the Mapping contract above.
That rule rejects the retention of state to influence a *naming* decision.
An example is a comparison of a new `--record-as` value with prior values to infer or deduplicate a variable name.
`recordedFillLiterals` never informs a naming decision.
The placeholder of every entry is exactly the name that the author already chose.
The map is consulted only to recognize that same, already-named value when it reappears in unrelated later evidence.
It is a redaction lookup, not a secret registry with a naming or comparison API.

**Two treatments, by data class:**

- **Result/event/backend-output fields** (display data, never compared at replay).
  These fields get content-aware substring redaction.
  This redaction reuses the same recursive backend-output scrub that the fill boundary already applies to its own entry.
  The redaction is generalized over every literal registered so far in the session.
  The substitution itself is one placeholder-safe left-to-right pass over each string, not N sequential full-string passes.
  A naive sequential pass over the same value can corrupt the just-inserted placeholder of an EARLIER pair.
  This occurs when the literal of a LATER pair happens to be a substring of that placeholder.
  For example, register `somethinglong -> ${ABC}`, then `ABC -> ${OTHER}`.
  A second pass over a value already rewritten to `${ABC}` matches "ABC" *inside* that token, and produces `${${OTHER}}`.
  The single pass tries every registered literal longest-first at each position.
  Thus, one registered value that is a substring of another (a username that is a prefix of a password) is never partially consumed by the shorter pair.
  The single pass also never re-scans text that it has already emitted.
  Thus, no literal can ever be matched inside the placeholder token of another pair, in either direction.
- **`target-v1`/`targets-v1` identity evidence** (`label`, `ancestry[].label`, `scrollRegion.label`: the fields that replay's own classification compares).
  This evidence is never silently text-substituted while it still claims a trustworthy identity.
  Replay compares recorded identity against the *live* tree.
  The live tree legitimately re-renders the real value again at replay time.
  Thus, a placeholder written into a recorded identity field could never verify correctly.
  Instead:
  - **Landmark mode (`wait`).** An echo is treated exactly like the existing identity-empty case of #1349.
    No annotation is recorded, and the wait keeps its selector-existence semantics.
    ADR 0016's destination guard requires `verification: "verified"`.
    Thus, a landmark whose only identity is an echo of a parameterized value simply stops qualifying as a guard.
    `session save-script` refuses it with the existing "record a selector-targeted wait on a labeled or id-bearing landmark" recovery.
    This reproduces the real resolution of the motivating scenario (a change of the guard to the stable `Apps` landmark).
    It makes that resolution an enforced outcome, not an authoring convention.
  - **Action mode (`get`, `is`, mutating element-targeting actions).** ADR 0012/0016 require identity evidence for every element-targeting recorded action and forbid silently dropping it.
    Thus, an echo here is never dropped.
    The literal-bearing label(s) are redacted to the placeholder.
    This redaction is content-aware and substring-based, unlike the exact-match fill-boundary redaction.
    The reason is that app-authored text typically surrounds a cross-step echo, such as "Welcome, `<value>`".
    `verification` is also downgraded to `"unverifiable"`.
    This is the same fail-closed downgrade that the writer-parser invariant of decision 3 already uses for an oversized payload.
    That downgrade makes the replay of the action fail loudly (`identity-unverifiable`).
    Replay does not silently weaken the action to selector-only matching, and the script does not publish a label that could never match again.

**Explicit scope limits:**

- A whitespace-only or empty resolved fill value is excluded from the session-wide registry.
  It keeps only the existing fill-step-scoped protection above.
  The collapse of arbitrary later strings on a value with no discriminating content has a disproportionate readability cost.
  Such a value reveals nothing distinctive if echoed.
  The collapse would also corrupt unrelated short incidental substrings throughout the rest of the recording.
- The originating fill's own recorded entry is protected only by the existing exact-match fill-boundary pass.
  That entry never goes through the coarser, substring-based session-wide pass with the pair that it just contributed.
  The session-wide guarantee is for later, distinct actions, exactly as #1398 frames it.
- An author's own explicitly typed selector or positional text is not scanned.
  Only derived, resolved evidence and result payloads are scanned.
  An author who types the secret directly into a new selector makes the same choice as an unparameterized fill/type value.
  That text remains literal script content.
- The registry is keyed by literal.
  Two distinct `--record-as` names can share the same typed value (for example, a password/confirm-password pair).
  From the perspective of a later echo, these names are genuinely indistinguishable, because the literal alone cannot tell which fill produced it.
  The first-registered name wins deterministically.
  The literal is redacted either way.
  Thus, this affects only the placeholder name to which a later echo is attributed, never whether the value is protected.

## Consequences

- Secret-bearing login/bootstrap scripts can use ADR 0016 active publication safely.
- The caller must opt in for every sensitive fill.
  Unparameterized fill/type values remain literal script content, and help warns accordingly.
- This decision does not add `type` and mutating `find ... fill|type` parameterization.
  If needed, they require their own surface and provenance design.
- No new publication format, variable store, or sensitivity heuristic is introduced.
  The #1398 amendment adds one ephemeral, non-serialized, per-session redaction map with no naming or lookup-by-name API.
  This map is never a persistent secret registry.
