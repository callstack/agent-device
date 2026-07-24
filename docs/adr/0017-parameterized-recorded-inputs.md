# ADR 0017: Parameterized Recorded Inputs

## Status

Accepted

## Context

Ordinary `.ad` recording persists executable inputs. A literal `fill` value therefore becomes part of
the published script, including any password or token supplied during authoring. Diagnostic and event
redaction cannot make that executable artifact safe because replay still needs the value.

Native replay already resolves `${VAR}` from `--env`/`-e` and `AD_VAR_*` immediately before dispatch.
The missing boundary is authoring: the live app needs the literal, while recording state and every
publication write must receive only the placeholder. Issue
[#1348](https://github.com/callstack/agent-device/issues/1348) defines this requirement; ADR 0016's
active-session publication deliberately excluded secret-bearing journeys until it was solved.

## Decision

Add a fill-only `recordAs` input, spelled `--record-as <VAR>` on the CLI and exposed as `recordAs` by
the Node and MCP fill contracts:

```sh
export AD_VAR_PASSWORD='<secret>'
agent-device open com.example.app --save-script=login.ad
agent-device fill 'id="password"' "$AD_VAR_PASSWORD" --record-as PASSWORD
agent-device wait 'role="heading" label="Home"'
agent-device session save-script
```

The live fill dispatch receives the literal. Its public response, recording state, session event, and
published script use `${PASSWORD}`. Replay later resolves the placeholder from `AD_VAR_PASSWORD` or
`--env PASSWORD=<value>` before the fill is dispatched.

Variable names use replay's uppercase `[A-Z_][A-Z0-9_]*` grammar. `AD_*` remains reserved for runtime
built-ins. `--record-as` is rejected unless script recording is armed, and it cannot be combined with
`--no-record`. Ordinary fills without the option keep literal recording behavior. Sensitivity is never
inferred from a selector, label, field name, or value shape.

### Mapping contract

The caller names the mapping explicitly. Reusing `PASSWORD` deterministically emits `${PASSWORD}`;
using `API_TOKEN` emits `${API_TOKEN}`. There is no secret-to-name table and no literal comparison or
deduplication state. This both avoids retaining a second copy of the secret and makes distinct-value
naming an authoring decision visible in the script.

### Data-flow boundary

The literal exists only on the live request path long enough to execute the interaction:

1. The request scope registers it as an explicit diagnostics secret before platform work. This is in
   addition to key-name redaction, because an opaque value need not look secret.
2. The platform interaction receives the literal.
3. Before response/event/recording retention, the fill result's semantic `text` field becomes
   `${VAR}` and every occurrence in a post-fill `refLabel` is parameterized. Stable selector/ref
   provenance is preserved byte-for-byte.
   Untrusted backend extras and nested settle output parameterize every occurrence of the supplied
   literal in both keys and values; post-fill selector-chain candidates are dropped only when a
   parsed `text`, `label`, or `value` term semantically contains it. Known response and settle
   schema fields are the explicit structural boundary and retain their names and provenance values.
   Because inline whitespace replacement cannot distinguish a sensitive value from ordinary
   separators, an untrusted string or key containing a whitespace-only literal collapses to the
   placeholder instead.
4. At `recordActionEntry`, the recorder reconstructs the fill's literal positional, writes only the
   placeholder into `SessionAction`, and parameterizes the semantic result field plus arbitrary
   backend/settle echoes again. ADR 0012 `target-v1` evidence keeps its structure; exact
   value-bearing accessibility labels become the placeholder without rewriting identity fragments
   that merely contain the same characters. The `recordAs` control flag itself is not serialized
   into the script. Parameterization is idempotent: this second pass preserves placeholders inserted
   at the response boundary even when the literal is part of the placeholder's variable name or is
   `$`.
5. The existing ADR 0012/0016 writer receives an already-parameterized action. Its selector provenance,
   portability checks, same-directory temp write, and atomic publication algorithm are unchanged.

Because the target and temp file are written from the same prepared script string, neither can contain
the literal once this pre-publication boundary has run.

### Replay and repair

Missing variables retain replay's existing fail-loud behavior: `${VAR}` resolution throws before the
corresponding action is invoked. When replay dispatches an authored fill whose complete text token is a
`${VAR}` placeholder, its daemon-only provenance channel derives `recordAs=VAR` for that live request.
This derivation uses the unresolved source action, independently of whether the resolved value is empty
or whitespace. If the replay is itself being recorded or repaired, the recorder therefore retains the
original placeholder rather than serializing the expanded value. Embedded interpolation remains
ordinary script input; safe authoring emits one complete placeholder token.

## Consequences

- Secret-bearing login/bootstrap scripts can use ADR 0016 active publication safely.
- The caller must opt in for every sensitive fill; unparameterized fill/type values remain literal
  script content and help warns accordingly.
- `type` and mutating `find ... fill|type` parameterization are not added by this decision. They require
  their own surface and provenance design if needed.
- No new publication format, variable store, secret registry, or sensitivity heuristic is introduced.
