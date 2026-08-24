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

### Session-scoped echo protection (amendment, #1398)

> **Status: accepted.** Amends the data-flow boundary above from fill-step-scoped to
> recording-session-scoped, per issue [#1398](https://github.com/callstack/agent-device/issues/1398).

The boundary above protects only the originating fill's own request/recording path. After
[#1349](https://github.com/callstack/agent-device/issues/1349), a later read-only action —
`wait`'s landmark-mode evidence, `is`, `get` — records `target-v1` identity evidence and a result
payload independently, computed from whatever the app renders at that later step. That capture has no
memory of an earlier fill's literal, so an app-rendered echo of it (the filled field's own displayed
value; a search result, validation message, or confirmation label containing it; a destination landmark
whose accessible label includes it) can re-enter session state and publication through a completely
different, unparameterized action — even though the originating fill was parameterized.

**The guarantee is now recording-session-scoped, not fill-step-scoped.** For the lifetime of one
recording session, no later recorded action's own result payload or `target-v1`/`targets-v1` identity
evidence may re-serialize an app-rendered echo of a literal the session already parameterized.

The mechanism is the smallest explicit, ephemeral state that can recognize a later echo:
`SessionState.recordedFillLiterals`, an in-memory `Map<literal, placeholder>` populated only by the SAME
(literal, placeholder) pair a `fill --record-as` entry already computes for its own boundary above — one
entry per parameterized fill, added only after that fill's own entry has been recorded. It is never
serialized (not to the script, the session event log, or diagnostics), has no read API beyond the
recorder that owns it, and disappears with the session.

This is not a reversal of the "no secret-to-name table" rule in the Mapping contract above. That rule
rejects retaining state to influence a *naming* decision — comparing a new `--record-as` value against
prior ones to infer or deduplicate a variable name. `recordedFillLiterals` never informs a naming
decision: every entry's placeholder is exactly the name the author already chose, and the map is
consulted only to recognize that same, already-named value reappearing in unrelated later evidence — a
redaction lookup, not a secret registry with a naming or comparison API.

**Two treatments, by data class:**

- **Result/event/backend-output fields** (display data, never compared at replay): content-aware
  substring redaction, reusing the same recursive backend-output scrub the fill boundary already applies
  to its own entry, generalized over every literal registered so far in the session. The substitution
  itself is one placeholder-safe left-to-right pass over each string, not N sequential full-string passes
  — a naive sequential pass over the same value can corrupt an EARLIER pair's just-inserted placeholder
  when a LATER pair's literal happens to be a substring of it (register `somethinglong -> ${ABC}`, then
  `ABC -> ${OTHER}`, and a second pass over a value already rewritten to `${ABC}` matches "ABC" *inside*
  that token, producing `${${OTHER}}`). The single pass tries every registered literal longest-first at
  each position — so one registered value that is a substring of another (a username that is a prefix of
  a password) is never partially consumed by the shorter pair — and never re-scans text it has already
  emitted, so no literal can ever be matched inside another pair's placeholder token in either direction.
- **`target-v1`/`targets-v1` identity evidence** (`label`, `ancestry[].label`, `scrollRegion.label` — the
  fields replay's own classification compares): never silently text-substituted while still claiming a
  trustworthy identity. Replay compares recorded identity against the *live* tree, which legitimately
  re-renders the real value again at replay time; a placeholder written into a recorded identity field
  could therefore never verify correctly. Instead:
  - **Landmark mode (`wait`).** An echo is treated exactly like #1349's existing identity-empty case: no
    annotation is recorded, and the wait keeps its selector-existence semantics. Because ADR 0016's
    destination guard requires `verification: "verified"`, a landmark whose only identity is a
    parameterized-value echo simply stops qualifying as a guard — `session save-script` refuses it with
    the existing "record a selector-targeted wait on a labeled or id-bearing landmark" recovery,
    reproducing the motivating scenario's real resolution (switching the guard to the stable `Apps`
    landmark) as an enforced outcome rather than an authoring convention.
  - **Action mode (`get`, `is`, mutating element-targeting actions).** ADR 0012/0016 require identity
    evidence for every element-targeting recorded action and forbid silently dropping it, so an echo here
    is never dropped. The literal-bearing label(s) are redacted to the placeholder (content-aware,
    substring-based — unlike the exact-match fill-boundary redaction, because a cross-step echo is
    typically surrounded by app-authored text such as "Welcome, `<value>`") and `verification` is
    downgraded to `"unverifiable"` — the same fail-closed downgrade decision 3's writer-parser invariant
    already uses for an oversized payload. That fails the action's replay loudly
    (`identity-unverifiable`) rather than silently weakening it to selector-only matching or publishing a
    label that could never match again.

**Explicit scope limits:**

- A whitespace-only or empty resolved fill value is excluded from the session-wide registry; it keeps
  only the existing fill-step-scoped protection above. Collapsing arbitrary later strings on a value with
  no discriminating content is a disproportionate readability cost for a value that reveals nothing
  distinctive if echoed, and would corrupt unrelated short incidental substrings throughout the rest of
  the recording.
- The originating fill's own recorded entry is protected only by the existing exact-match fill-boundary
  pass; it is never passed through the coarser, substring-based session-wide pass using the pair it just
  contributed. The session-wide guarantee is for later, distinct actions, exactly as #1398 frames it.
- An author's own explicitly typed selector or positional text is not scanned — only derived, resolved
  evidence and result payloads are. An author who types the secret directly into a new selector is making
  the same choice as an unparameterized fill/type value; that remains literal script content.
- The registry is keyed by literal, so two distinct `--record-as` names that happen to share the same
  typed value (a password/confirm-password pair, say) are genuinely indistinguishable from a later
  echo's perspective — the literal alone cannot say which fill produced it. The first-registered name
  wins deterministically; the literal is redacted either way, so this only affects which placeholder
  name a later echo is attributed to, never whether the value is protected.

## Consequences

- Secret-bearing login/bootstrap scripts can use ADR 0016 active publication safely.
- The caller must opt in for every sensitive fill; unparameterized fill/type values remain literal
  script content and help warns accordingly.
- `type` and mutating `find ... fill|type` parameterization are not added by this decision. They require
  their own surface and provenance design if needed.
- No new publication format, variable store, or sensitivity heuristic is introduced. The #1398 amendment
  adds one ephemeral, non-serialized, per-session redaction map with no naming or lookup-by-name API —
  never a persistent secret registry.
