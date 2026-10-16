# ADR 0017: Parameterized Recorded Inputs

## Status

Accepted

## Rules at a glance

- Use fill-only `recordAs`, CLI `--record-as <VAR>`, for explicit parameterized inputs.
- Send the literal to the app. Retain only `${VAR}` in the fill's response, recording, event, and script.
- Use uppercase `[A-Z_][A-Z0-9_]*` variable names. Reserve `AD_*` for runtime built-ins.
- Reject `--record-as` without armed recording or with `--no-record`.
- Never infer sensitivity or variable names from values, selectors, labels, or field names.
- Replay derives `recordAs` only for complete placeholder text tokens, preserving placeholders during recorded replay or repair.
- Protect later derived results and identity evidence from registered literal echoes under the session-scoped amendment's limits.
- Keep unparameterized fill/type inputs literal. Do not scan explicitly authored selectors or positional text.

## Context

Ordinary `.ad` recording persists executable inputs.
A literal `fill` value therefore enters the script, including authoring passwords or tokens.
Diagnostic/event redaction cannot protect an executable artifact because replay still needs its value.

Native replay already resolves `${VAR}` from `--env`/`-e` and `AD_VAR_*` immediately before dispatch.
The missing boundary is authoring.
The app needs the literal, but recording state and every publication write must receive only the placeholder.
Issue [#1348](https://github.com/callstack/agent-device/issues/1348) defines this requirement.
ADR 0016 deliberately excluded secret-bearing journeys until its resolution.

## Decision

Add fill-only `recordAs` input.
CLI spells it `--record-as <VAR>`.
Node and MCP fill contracts expose `recordAs`:

```sh
export AD_VAR_PASSWORD='<secret>'
agent-device open com.example.app --save-script=login.ad
agent-device fill 'id="password"' "$AD_VAR_PASSWORD" --record-as PASSWORD
agent-device wait 'role="heading" label="Home"'
agent-device session save-script
```

Live fill dispatch receives the literal.
Its public response, recording state, session event, and script use `${PASSWORD}`.
Before replay dispatch, `AD_VAR_PASSWORD` or `--env PASSWORD=<value>` supplies the value.

Variable names use replay's uppercase `[A-Z_][A-Z0-9_]*` grammar.
`AD_*` remains reserved for runtime built-ins.
Without armed recording, `--record-as` is rejected.
It cannot combine with `--no-record`.
Ordinary fills without it retain literal recording behavior.
Sensitivity is never inferred from selector, label, field name, or value shape.

### Mapping contract

The caller explicitly names the mapping.
Reused `PASSWORD` deterministically emits `${PASSWORD}`.
`API_TOKEN` emits `${API_TOKEN}`.
There is no secret-to-name table, literal comparison, or de-duplication state for naming.
This avoids a second retained secret copy for that purpose.
It also makes distinct-value names visible authoring decisions.

### Data-flow boundary

The literal exists only on the live request path long enough to execute the interaction:

1. Before platform work, the request scope registers the literal as an explicit diagnostics secret.
   This supplements key-name redaction because opaque values may not resemble secrets.
2. Platform interaction receives the literal.
3. Before response/event/recording retention, semantic result `text` becomes `${VAR}`.
   Every occurrence in post-fill `refLabel` is parameterized.
   Stable selector/ref provenance remains byte-for-byte unchanged.
   Untrusted backend extras and nested settle output parameterize literal occurrences in keys and values.
   Post-fill selector-chain candidates are dropped only if parsed `text`, `label`, or `value` terms semantically contain the literal.
   Known response/settle schema fields define the structural boundary and retain names and provenance values.
   For whitespace-only literals, an affected untrusted string or key collapses to the placeholder.
   Inline replacement cannot distinguish sensitive whitespace from ordinary separators.
4. At `recordActionEntry`, the recorder reconstructs the fill's literal positional and writes only the placeholder into `SessionAction`.
   It parameterizes semantic result and arbitrary backend/settle echoes again.
   ADR 0012 `target-v1` evidence retains its structure.
   Exact value-bearing accessibility labels become placeholders.
   Identity fragments that merely contain the same characters remain unchanged.
   The `recordAs` control flag is not serialized.
   Parameterization is idempotent.
   The second pass preserves existing placeholders even if the literal is `$` or part of the variable name.
5. The ADR 0012/0016 writer receives an already-parameterized action.
   Selector provenance, portability checks, same-directory temp write, and atomic publication remain unchanged.

Target and temp files use the same prepared script string.
After this pre-publication boundary, neither can contain the literal.

### Replay and repair

Missing variables retain replay's explicit failure behavior.
`${VAR}` resolution throws before the corresponding action is invoked.
For authored fills whose complete text token is `${VAR}`, daemon-only provenance derives `recordAs=VAR` for the live request.
It uses unresolved source action, independently of empty or whitespace resolved values.
Thus, recorded replay or repair retains the original placeholder instead of the expanded value.
Embedded interpolation remains ordinary script input.
Safe authoring emits one complete placeholder token.

### Session-scoped echo protection (amendment, #1398)

> **Status: accepted.** This amendment extends fill-step protection to recording-session scope under [#1398](https://github.com/callstack/agent-device/issues/1398).

The original boundary protects only the originating fill request and recorded entry.
After [#1349](https://github.com/callstack/agent-device/issues/1349), later read-only actions independently record `target-v1` evidence and results from app-rendered state.
These include `wait` landmark evidence, `is`, and `get`.
Without memory of the earlier literal, an unrelated unparameterized action could retain an app-rendered echo through:

- The filled field's displayed value.
- A search result.
- A validation message.
- A confirmation label.
- A destination landmark label.

**The guarantee now applies to the recording session.**
During that session, no later action's result or `target-v1`/`targets-v1` evidence may serialize an app-rendered echo of an already-parameterized literal.
The explicit limits below apply.

`SessionState.recordedFillLiterals` provides the minimum explicit ephemeral state needed to recognize later echoes.
This in-memory `Map<literal, placeholder>` receives the same pair already computed by `fill --record-as` for its own boundary.
It adds one entry per parameterized fill, only after that fill's entry is recorded.
It never serializes to scripts, session event logs, or diagnostics.
Only its owning recorder can read it.
It disappears with the session.

This does not reverse the Mapping contract's prohibition on a secret-to-name table.
That prohibition concerns state used to infer or de-duplicate variable names by comparison with earlier values.
`recordedFillLiterals` never selects names.
Every placeholder is exactly the author's chosen name.
The map only recognizes that named literal in later unrelated evidence.
It provides redaction, without a naming or comparison API.

**Data classes receive two treatments:**

- **Result/event/backend-output fields.** These display values are never compared during replay.
  Content-aware substring redaction reuses the fill boundary's recursive backend-output scrub for every literal registered so far.
  Each string receives one placeholder-safe left-to-right pass, not sequential full-string passes per literal.
  Sequential passes could match a later literal inside an earlier inserted placeholder.
  For example, register `somethinglong -> ${ABC}`, then `ABC -> ${OTHER}`.
  Reprocessing `${ABC}` could produce `${${OTHER}}`.
  Instead, the single pass tries registered literals longest-first at each position.
  A shorter literal cannot partially consume a longer one, such as a username that prefixes a password.
  The pass never scans emitted text again.
  Thus, one pair's literal cannot match inside another pair's inserted placeholder in either direction.
- **`target-v1`/`targets-v1` identity evidence.** Replay compares `label`, `ancestry[].label`, and `scrollRegion.label` against the live tree.
  These fields must never receive silent text substitution while retaining a trustworthy identity claim.
  The live app legitimately renders the real value again.
  A placeholder in trusted recorded identity therefore could not verify correctly.
  Apply these rules instead:
  - **Landmark mode (`wait`).** Treat an echo like #1349's identity-empty case.
    Record no annotation and retain selector-existence semantics.
    ADR 0016 requires `verification: "verified"` for destination guards.
    A landmark whose only identity echoes a parameterized value therefore stops qualifying.
    `session save-script` refuses it with existing "record a selector-targeted wait on a labeled or id-bearing landmark" recovery.
    This enforces the motivating scenario's correction to stable `Apps` landmark selection.
  - **Action mode (`get`, `is`, mutating element-targeting actions).** ADR 0012/0016 require identity evidence and forbid silent omission.
    Never drop echo-bearing identity here.
    Redact literal-bearing labels to placeholders through content-aware substring replacement.
    Unlike the originating fill's exact-match rule, cross-step echoes commonly include surrounding app text, such as "Welcome, `<value>`".
    Downgrade `verification` to `"unverifiable"`, as decision 3's writer-parser invariant does for oversized payloads.
    Replay then fails explicitly with `identity-unverifiable`.
    It neither weakens to selector-only matches nor claims an identity label that cannot match again.

**Explicit scope limits:**

- Empty or whitespace-only resolved values do not enter the session-wide registry.
  They retain existing fill-step protection only.
  They disclose no distinctive content through echoes.
  Collapsing arbitrary later strings would impose disproportionate readability costs and corrupt incidental substrings.
- The originating fill's entry uses only its existing exact-match fill-boundary pass for the new pair.
  It never uses that pair in the coarser session-wide substring pass.
  The session-wide guarantee covers later distinct actions, as #1398 specifies.
- Explicitly authored selectors and positional text are not scanned.
  Only derived resolved evidence and results receive protection.
  A secret typed into a new selector remains literal script content, like unparameterized fill/type input.
- The registry key is the literal.
  If distinct `--record-as` names share a typed value, later echoes cannot identify their source fill.
  The first-registered name wins deterministically.
  This changes placeholder attribution only, never literal protection.

## Consequences

- Secret-bearing login/bootstrap scripts can safely use ADR 0016 active publication under these rules.
- Callers must opt in for every sensitive fill.
  Unparameterized fill/type values remain literal content, with a help warning.
- This decision adds no parameterization for `type` or mutating `find ... fill|type`.
  If needed, they require separate surface and provenance design.
- No new publication format, variable store, or sensitivity heuristic is introduced.
  The #1398 amendment adds one ephemeral non-serialized per-session redaction map.
  It has no naming or lookup-by-name API and never becomes a persistent secret registry.
