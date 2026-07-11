# Contract projection and output-economy spike

Issues: #1185, #1186

This report records two completed, bounded experiments: one typed command family for executable
contract projection and one opt-in response family for digest expansion. Neither result starts a
repository-wide migration.

## Selection evidence

### Executable contract: typed system navigation

Selected commands:

- `home`
- `back`
- `rotate`
- `app-switcher`
- `tv-remote`

These commands already have closed neutral results in `src/contracts/navigation.ts`, typed
`CommandResultMap` entries, executable definitions, Node client methods, and MCP output schemas.
They do not overlap the broad-return client methods being changed under #1183.

The baseline has three independent command-to-surface declarations per selected command:

1. the facet's client-method mapping;
2. the public client method signature;
3. the keyed MCP output-schema entry.

That was 15 independent projection declarations around five executable definitions. The experiment
made each executable definition the single command-to-client/MCP projection declaration and
derived the client surface and MCP schema map from those five definitions. It reached five
declarations instead of 15 without changing CLI, daemon, client, or MCP behavior.

The experiment stops at these five commands. It must not continue if it needs generated source, a
schema DSL, a new dependency, a parallel registry, a new import back-edge, weaker parity checks,
more hand-authored declarations, or a measurable cold-start or bundle regression.

### Digest response: network observations

Deterministic representative payloads rank the unregistered candidates as follows:

| Family | Default bytes | Conservative digest estimate | Reduction | Selection |
|---|---:|---:|---:|---|
| network (`include=all`) | 26,371 | 1,665 | 24,706 (93.7%) | selected |
| events | 7,686 | 3,375 | 4,311 (56.1%) | rejected |
| debug symbols | 4,804 | 2,054 | 2,750 (57.2%) | rejected |
| recording | 3,132 | 2,427 | 705 (22.5%) | rejected |

The network estimate removes only repeated payload material from each entry (`headers`,
`requestHeaders`, `responseHeaders`, `requestBody`, `responseBody`, and `raw`). It retains every
entry and its method, URL, status, timestamp, duration, packet ID, and source line, plus top-level
path/state/backend/include, limits, scan counts, notes, and additive fields.

The other candidates require less conservative compromises:

- event `details` can contain refs, error identity, request logs, and recovery data;
- debug frames and matched images are the diagnostic evidence;
- recording chunks and artifacts are retrieval handles.

The existing routine-workflow oracle remains the actionability floor: 2,276 total bytes across
seven commands, zero fallback observations, exactly one retry, and all in-session recovery handles
preserved. The network addition must keep those measurements unchanged and separately prove that a
failed request remains identifiable and actionable from the digest.

## Measurement method

- Declaration count: count independent selected-command projection declarations before and after.
- Runtime: compare median cold imports of the MCP command-tool projection at the merge base and
  spike head.
- Bundle: compare `pnpm size` raw/gzip totals and relevant chunks at the merge base and spike head.
- Dependencies: run the layering/back-edge gate and verify no package dependency changes.
- Output economy: commit default and digest bytes, then assert default byte identity, retained
  request identity/recovery notes, and unchanged routine-workflow fallback/retry counts.

The merge-base size baseline is 1,659,106 raw JS bytes, 529,658 gzip bytes, and 636,721 tarball
bytes on Node 24.13.0.

## Contract projection results (#1185)

The five selected navigation commands now carry one colocated projection declaration each in
`src/commands/system/navigation-projection.ts` (`NAVIGATION_COMMAND_PROJECTIONS`): client-method name, public option
shape, closed result type, and MCP `outputSchema`. The family builder derives `clientCommandMethods`
from those projections, `AgentDeviceCommandClient` derives the five navigation methods via
`ProjectedNavigationCommandClient`, and `COMMAND_OUTPUT_SCHEMAS` spreads the projected schemas.

- Declarations: 15 -> 5 (10 fewer). Removed the per-command facet `clientMethod`, the hand-written
  client method signature, and the hand-authored MCP schema entry.
- Behavior: CLI, daemon, client runtime, and MCP output schemas unchanged (unit/client/MCP tests pass).
- Bundle: +773 B raw JS, +146 B gzip, +620 B tarball; no material chunk regression, no dependency change.
- Runtime: CLI --version 20.3 ms / --help 39.5 ms median (20 runs); no cold-start regression.
- Layering/Fallow: green; no new value back-edge (type-only import from client, value import only
  from the already-command-importing MCP schema map).

The selected five-command experiment is complete. Other already-typed closed-contract families are
candidates only, not a migration queue. Any follow-up must be proposed and measured independently,
must reduce declarations without weakening ownership or parity checks, and must stop on any of the
conditions above. Generated source, a schema DSL, a new dependency, a parallel registry, a new
back-edge, or a material runtime/bundle regression remains a stop signal.

## Digest expansion results (#1186)

Added one conservative, opt-in `network` response view in `src/daemon/response-views.ts`
(registered as `RESPONSE_VIEWS.network`). It acts ONLY at `responseLevel: 'digest'`; `default`
and `full` return the same object reference, so the default wire shape stays byte-identical
(Maestro `.ad` recompare safe) and live metrics remain informational.

Transformation: the entire top-level dump (`path`, `exists`, `active`, `state`, `backend`,
`include`, `scannedLines`, `matchedLines`, `limits`, `notes`, and any additive fields) is
preserved, EVERY entry is preserved (none dropped, capped, or reordered), and only the verbose
per-entry payload fields are removed: `headers`, `requestHeaders`, `responseHeaders`,
`requestBody`, `responseBody`, `raw`. Each entry keeps its actionable identity — `method`, `url`,
`status`, `timestamp`, `durationMs`, `packetId`, `line`, and any additive fields such as
`metadata`.

Measured on the deterministic `selection.network` fixture (`network ... --include all`, 8 entries):

- Output bytes: 26,371 -> 1,665 (24,706 fewer / 93.7% reduction).
- Entries preserved: 8 -> 8 (no follow-up refetch needed; identity intact).
- Follow-up actionability: the failed POST keeps method/url/status/packetId/duration/timestamp and
  the top-level recovery note, so the retry path is unchanged (no extra follow-up calls implied).
- Fallback observations: 0 (routine-workflow oracle unchanged).
- Retries: 1 (routine-workflow oracle unchanged).
- Recovery/session fields: preserved (routine-workflow oracle unchanged).

Defaults are unchanged; the digest is strictly opt-in via a non-default response level. Residual
risk: the dropped-field set is intentionally specific to the known verbose network payload fields;
if a backend introduces a new large per-entry field it would remain until added to the drop list
(safe by default — unknown fields are preserved, never silently narrowed).

The selected network experiment is complete. Events, debug symbols, recording, and any new family
remain candidates only. A follow-up requires paired evidence:

1. deterministic byte/shape reduction on representative fixtures; and
2. unchanged or better actionability, including follow-up command choice, fallback observation
   count, retry count, identity, refs, warnings, artifacts, and in-session recovery.

Byte reduction alone is not a successful digest.

## Post-merge closeout evidence

The deterministic suite was rerun after both implementations merged:

- `pnpm test:output-economy`: 4 files and 26 tests passed.
- Network default/digest: 26,371 / 1,665 bytes; all eight entries and failed-request identity
  remain available.
- MCP snapshot result: 1,173 bytes with four refs in the combined text + structured result.
- Routine workflow: 2,276 bytes across seven commands, zero fallback observations, one retry, and
  `recoveryPreservesSession=true` with code, session, refs generation, retriable flag, and hint.

`pnpm bench:help-conformance --dry-run` generated eight prompts for the four output/recovery cases
across the configured Haiku and GPT mini runners. This proves case selection and prompt plumbing
only. No scored small-model result is recorded here because authenticated `claude` and `codex`
runners were unavailable; future scored runs remain informational actionability oracles, not CI
gates.

No new live-device result is recorded in this closeout. The local environment had no simulator,
emulator, or attached device. A one-round `perf-nightly` dispatch on the PR branch was also
unavailable because the GitHub integration could not create workflow-dispatch events. Historical
Android nightly logs did expose a deterministic workflow defect: the emulator action executes each
`script` line independently, so shell continuation backslashes reached `scripts/perf/run.ts` as a
literal `\` argument. The action now receives one folded shell script, so `set -e` governs the
benchmark and no continuation tokens cross action boundaries. The next scheduled run after merge
is the live validation point. Deterministic fixtures are not presented as live reliability
evidence.

The six-month churn × current-size refresh continues to identify bounded candidates rather than a
split mandate:

| File | Commits | LOC | Churn × LOC |
|---|---:|---:|---:|
| `src/cli/parser/cli-help.ts` | 34 | 1,227 | 41,718 |
| `src/core/dispatch-interactions.ts` | 31 | 1,123 | 34,813 |
| `src/client/client-types.ts` | 21 | 1,139 | 23,919 |

Higher-churn files below 1,000 lines include `src/core/dispatch.ts`, `src/cli.ts`, and several
daemon handlers. These are seam-stability signals, not automatic split targets. A future split must
answer one ownership question, improve locality, preserve dependency direction, and mirror source
and test topology. The refresh deliberately avoids a blanket LOC gate; path-based commit counts
also undercount renamed files unless inspected with `git log --follow`.

Repeat the broad ranking with:

```sh
SINCE="$(node -e "const d = new Date(); d.setUTCMonth(d.getUTCMonth() - 6); process.stdout.write(d.toISOString().slice(0, 10))")"
git log --since="$SINCE" --name-only --pretty=format: -- 'src/**' \
  | rg -v '^$|__tests__|\.test\.' | sort | uniq -c | sort -rn \
  | while read -r commits file; do
      test -f "$file" || continue
      lines="$(wc -l < "$file")"
      printf '%d\t%d\t%d\t%s\n' "$((commits * lines))" "$commits" "$lines" "$file"
    done \
  | sort -rn
```

`src/utils` contains 106 TypeScript files: 71 production files and 35 tests. That is a standing
opportunistic ownership policy, not a mass relocation backlog.
