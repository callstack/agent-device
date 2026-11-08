# Divergence report and resume

These contracts supplement [ADR 0012](../../../docs/adr/0012-interactive-replay.md) decision 4.
`@agent-device/contracts` holds the `details.divergence` shape.
`@agent-device/ad-replay` bounds the report and resolves the resume point.
The [divergence construction contract](../../replay-port/docs/replay-divergence.md) owns the screen, the suggestions, and `repairHint` computation.

## Report fields

Both action failure and target-binding mismatch return `ok:false`, code `REPLAY_DIVERGENCE`, and `details.divergence`.
The version `1` object contains these fields:

- `kind`
- `step` (`index`, `source.path`, `source.line`)
- `action`
- `cause`
- `screen`
- `suggestions`
- `resume`
- `repairHint`
- For binding failures, `targetBinding` (`classification`, `matchCount`, `recorded`, `observed`, `mismatches`, `candidates`)

`kind` is `action-failure`, `selector-miss`, `identity-mismatch`, or `identity-unverifiable`.
The last three are the target-binding classes of the [target annotation contract](../../ad-script/docs/target-annotation.md).
`targetBinding.classification` always equals top-level `kind`.
The verification path determines `targetBinding.matchCount` presence:

- Present, with range 0..N, for `selector-miss` and `identity-mismatch`
- Present for resolution-derived `identity-unverifiable` (path 6)
- Omitted, never `null`, for recorded-unverifiable evidence before resolution (path 1)

`step.index` is the 1-based executable-plan ordinal.
The source location is diagnostic only.
A Maestro parser must preserve original files and lines through includes so the caller can use the location.

`repairHint` is one bounded enum value from a fixed closed set: `record-and-heal`, `state-repair`, `caution`, `manual`.
It is never a list.
The daemon computes it under ADR 0012 decision 6, R3.
Every divergence includes it, with `manual` when no safer route is proven.
It is never absent or null.
Its small fixed size permits inclusion at every response level, including `--level digest`.
It must survive these four projections unchanged: daemon text summary, JSON, Node client `AppError`, and MCP `structuredContent`.

`screen` has two discriminated forms.
`{ state: "available", refsGeneration, refs, truncated }` is a fresh healthy snapshot digest.
Only this form issues actionable refs.
`{ state: "unavailable", reason, hint }` indicates failed or sparse capture.
It has no refs or generation and must not reuse the old session tree.
Capture failure never replaces or conceals the original replay cause.

## Bounds

Response limits apply to the entire serialized UTF-8 `details.divergence` object:

| Response level | Byte ceiling | Screen refs | Suggestions |
| --- | --- | --- | --- |
| Compact (`--level digest`) | 8 KiB | At most 8 | No entries; `suggestionCount` |
| Default | 24 KiB | At most 20 | At most 5 |
| Full | 64 KiB | At most 20 | At most 5 |

`suggestionCount` counts entries available at default/full level.
It tells callers whether a higher-level fetch has more material.
Default/full suggestions follow the suggestion total order.
Counts are absolute, including error payloads.
These individual values are UTF-8 truncated to **256 bytes**: labels, ids, selectors, source paths, mismatch values, cause messages, and hints.

An action summary has no positional array.
Arbitrary nested cause details are never serialized.
Maestro failure provenance uses resolved diagnostic identifiers, including targets and `runFlow` paths.
It names the attempted runtime operation instead of unresolved `${VAR}` or synthetic `<var:VAR>` tokens.

## Redaction

Text-entry payloads remain semantic secrets.
`inputText` progress, failure messages, suggestions, and overflow artifacts never serialize entered text.
Injected replay values are not global sensitive literals.
Otherwise, a short ordinary value such as `2` or `on` would corrupt unrelated timestamps, paths, and typed error fields throughout the request log.
The actual text-entry dispatch boundary registers values before platform work, independently of the failure projection.
Users must not put secrets in selectors, links, filenames, or other diagnostic identifiers expected in failure output.

Native `.ad` replay retains categorical `<var:NAME>` replacement in human-readable divergence messages, hints, and bounded diagnostic fields.
This existing fail-closed policy remains separate from Maestro compatibility output.
Semantically masked positionals and daemon-owned machine-readable fields and paths never receive substring replacements.
The report marks every truncation, redaction, and omission.

## Overflow

Level caps apply first. Only when the level-capped serialized report still exceeds its byte ceiling does the daemon write the same redacted, per-field-bounded detail to a session-scoped divergence artifact. Material that level caps omit while the report fits creates no artifact.
It returns the path and `overflow: { omittedBytes, artifactPath }`.
If the write fails, it returns `artifactUnavailable: true` and preserves the original error.
The artifact contains no raw snapshot tree or unredacted input.

## Surfaces

All surfaces preserve the daemon error.
The Node client rejects with `AppError` and retains `details.divergence`.
CLI exits nonzero.
Text shows a compact report; JSON includes the complete structured error.
MCP returns `isError: true`, the object in `structuredContent`, and the same compact text summary.
MCP treats divergence as a ref-issuing result, including on the error path.
Before return, it merges and pins every `screen` ref with `refsGeneration`.
CLI and direct clients receive the daemon error's unpinned refs and generation.
No surface may reduce divergence to text and discard repair data.

Divergence `screen.refs` issues a bounded partial ref frame (ADR 0014).
`markSessionPartialRefsIssued` authorizes exactly those refs.
MCP pins them automatically.
CLI text renders `@eN~s<refsGeneration>`.
JSON and Node.js callers pair each plain ref with the response-level generation before mutation.
A mutation through this partial frame requires a pinned ref.
A plain ref returns `plain_ref_requires_complete_frame`.

## Resume ordinal

`--from N` belongs only to `replay`.
`test` must reject it with `INVALID_ARGS` because a suite run must remain full and deterministic.
`N` is a 1-based index into the fully expanded executable plan.
`N` must be in the plan range, except for the watermark-authorized empty-tail resume described below.
It is not a YAML line, fractional source-step number, or repeat iteration label.
Static includes, platform conditions, and fixed-count repeats expand before indexing.
Repeated source lines therefore have distinct plan indices.

Every divergence includes `resume: { allowed, from, reason?, planDigest, alternateFrom?, repairSessionHeld? }`.
`repairHint` determines `from` (ADR 0012 decision 6, R2/R3):

- For `record-and-heal`, `from` is the index of the failed step **+ 1** (N + 1).
  The agent performs that step as a recorded action before it resumes.
  A resume AT that step would diverge again on the exact step that the agent just completed.
- For `state-repair`, `caution`, and `manual`, `from` remains **N**.

For single-path hints (`record-and-heal`, `state-repair`), `from` describes the complete continuation.
A JSON/MCP-first caller that blindly resumes at `resume.from` therefore reads the same command that the text guidance renders.
It never gets a stale `from` that loops the caller back onto the step that it just repaired.
For dual-path hints (`caution`, `manual`), `from` describes only app-state repair.
Their optional `alternateFrom` describes recorded correction.
Structured callers read both fields to obtain both text alternatives.

For `caution`/`manual`, there are two legitimate repairs, and the daemon cannot disambiguate them at divergence time (#1262):

- App-state fix: use `--no-record`, then repeat unchanged step N at `from`.
- Recorded correction: perform step N's intent as a recorded action, then continue at N + 1.

`alternateFrom` carries N + 1 for these hints when it is in range, or when a live session can authorize an empty tail.
The builder does not run a separate plan-safety preflight for the alternate.
The `ReplayResumeCheck` list validates range, corrective action growth, and digest on the resume request.
`record-and-heal` omits it because `from` already carries N + 1.
`state-repair` omits it because it has no recorded-action alternate.
Text renders the N + 1 command **if and only if `alternateFrom` exists**.
Clients never recompute resumability.
Text and structured output therefore advertise identical commands.

## Empty-tail resume and the corrective watermark

`actions.length + 1` is a legal **empty-tail resume** for a repaired final step.
It executes zero device actions and follows normal end-of-plan completion.
An armed transaction becomes `COMPLETE`, which permits its later `close` commit.
Otherwise, `close` would abort the incomplete transaction and discard the correction.

This ordinal requires authorization from the exact session and target that produced it.
The daemon stamps a per-session watermark (`expectedFrom`, the authorized resume ordinal, and `actionsCountAtDivergence`, the recorded action count at divergence time) in these cases:

- For `record-and-heal` with `allowed: true`, the reported `from` is already N + 1.
- For a `caution`/`manual` final-step alternate, the watermark uses `alternateFrom` N + 1.
  The primary `from` remains N.

Only a live session can receive this watermark.
Without one, an empty-tail `alternateFrom` is omitted.
Otherwise, the daemon would advertise a `--from N + 1` that it must then reject.
Examples include a one-step `open` failure or a session closed during replay.
A later empty-tail resume must match the watermark and show growth in the session's action count.
That growth proves a corrective action was recorded.
It prevents unrelated or blind resumes from skipping the unresolved last step and committing an incomplete repair.
Every other `record-and-heal` continuation uses the same watermark and count-growth guard, including ordinals inside the plan.
If the count is unchanged, resume refuses to skip the unrepaired step.

## Plan digest

`planDigest` is SHA-256 over the canonical fully expanded plan.
It includes command, normalized inputs, control shape, platform-conditioned expansion, and source provenance.
Normalized inputs include positionals/flags, execution-affecting `runtime` hints, and `target-v1` identity evidence.
Identity evidence affects pre-action execution and must therefore affect the digest.
Platform-conditioned expansion uses the **effective resolved `platform`/`target`**.
CLI flags override script metadata.
A digest for one target is not reusable for another.
Native `.ad` `${VAR}` **values are excluded** because substitution follows planning.
Changes only to late-bound values retain the digest.
Maestro substitutes environment values during compatibility parsing.
Those values can change action inputs, includes, or control expansion and therefore the digest.

Resume requires both `--from N` and `--plan-digest <planDigest>` from the report.
The daemon rebuilds the current plan.
If the digest differs, it returns `INVALID_ARGS` before any action.
Edits or parse-time expansion cannot silently change ordinal N's target.
An edited script requires a fresh full replay and a new digest.
`allowed: false` explains why resume is unsafe.
Its digest remains diagnostic and cannot bypass preflight.

## Resumability and session lifetime

`allowed` describes **plan resumability only**.
Every divergence emits it.
It says nothing about session lifetime.
The separate `repairSessionHeld: true` signal identifies an active repair transaction persisted on the session.
A `--save-script` replay opens the transaction.
Commit or abort ends the transaction (ADR 0012 decision 6, R7).
The daemon sets `repairSessionHeld: true` until the transaction ends.
A `--from` continuation without `--save-script` still reports `repairSessionHeld: true`, because the persisted transaction state determines this field, not the flags of the current request.
Only this signal promises a live addressable daemon/session for repair.
R7's lifetime guarantee never uses `allowed`.
A non-armed replay can report `allowed: true` and then terminate its session normally.
Thus a consumer must not read `allowed: true` as "the session is still there."

## Preflight

Resume reconstructs no execution state.
For Maestro plans and `N > 1`, preflight rejects with `INVALID_ARGS` under either condition:

- A skipped action can produce `outputEnv` values.
- The skipped range or resume target is inside runtime conditional, retry, or dynamic-repeat control flow.

After resume, only explicit script/header, CLI, and shell inputs supply variables.
If the planner cannot prove that scope, it rejects the request.
The daemon never infers app state.
Before resume, the caller must establish the required app state.

Help documents the resume protocol and resume rejections.
Successful text replay prints one line with replayed count and wall time.
`--json` remains structured.

## Required coverage

- Divergence reports: compact/default/full field and byte ceilings; digest output includes `suggestionCount` without entries; redaction, overflow artifacts, artifact-write failure, available/sparse/capture-failed screens, and original-cause preservation.
- Resume: digest emission and rejection after script/include/expansion changes; `resume.allowed` reasons, `--from` indexing, variable-output rejection, control-flow rejection, and `test --from` rejection.
- Surfaces: daemon/client/CLI/MCP tests prove typed divergence survives failure.
  JSON and MCP structured output retain it.
  MCP pins only actionable error-path refs.
  No text-only path discards the report.
  `repairHint` is present and identical in text, JSON, client `AppError`, and MCP `structuredContent`, including compact `--level digest`.
- `--update` retirement: no source-file rewrite; suggestions remain bounded, ranked, and deduplicated under the suggestion total order.
