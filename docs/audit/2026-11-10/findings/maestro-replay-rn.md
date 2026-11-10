## Coverage

Slice: `packages/maestro`, `packages/replay-port`, `packages/replay-test`, `packages/ad-replay`, `packages/ad-script`, `packages/react-native` (~61k lines incl. tests; ~32k production).

- Read fully (production): `ad-script` (script.ts, script-utils.ts, vars.ts, open-script.ts, format.ts, replay-input.ts, script-formatting.ts, recorded-input.ts, target-annotation-serde.ts); `ad-replay` step-loop.ts, resume.ts, inspect.ts, plan-digest.ts, verify-dispatch.ts, most of target-verification.ts; `replay-port` native-command.ts, session-replay-runtime-plan.ts, session-replay-runtime-session.ts, session-replay-runtime-engine-adapter.ts, session-replay-action-runtime.ts, session-replay-trace.ts, session-replay-resume.ts, test-command.ts, session-test-shard-devices.ts, session-test-source-discovery.ts, source-discovery.ts, script-source-bundle.ts; `replay-test` session-test.ts, session-test-runtime.ts, session-test-discovery.ts, session-test-sharding.ts; `maestro` program-ir.ts, program-ir-parser.ts, program-ir-flow-parser.ts, program-ir-command-parser.ts, engine-flow.ts, engine-context.ts, engine-expression.ts, engine-eval-script.ts, engine-truthiness.ts, compatibility-policy.ts, replay-plan-step-execution.ts, replay-plan-resume.ts, replay-plan-digest.ts, source-closure.ts, program-loader.ts, support-matrix.ts, daemon-runtime-port.ts, run-script-execution.ts, run-script-http.ts, run-script-http-child.ts, wait-for-animation-to-end.ts, maestro-screenshot-comparison.ts, most of session-replay-maestro-runtime.ts and daemon-runtime-port-observation.ts.
- Skimmed / grep-probed: `maestro` program-ir-values.ts, runtime-port-commands.ts, daemon-runtime-tap.ts, daemon-runtime-public-operation.ts, index.ts; `replay-port` session-replay-divergence.ts (capture retry only), package exports; `react-native` client-metro.ts (polling loops, bridge retry), client-companion-tunnel-worker.ts (main loop); all polling loops, error-text matching, legacy markers, fallow suppressions, and assertion-free tests across the slice.
- Not reached: `maestro` runtime-target*/runtime-selector-resolution/runtime-port-geometry/export-flow/selector parsers/replay-plan-steps/facade-execution and `test/conformance/**`; `replay-port` target-classification, target-verification, divergence report building, heal, video recording, repair-hint; `replay-test` session-test-attempt.ts and session-test-artifacts.ts; `ad-script` identity/classification; `react-native` react-devtools/*, profile analysis, companion tunnel client; nearly all test files.
- Rough coverage: ~45% of production lines read, ~15% more probed by grep; tests ~5%.

Negative results worth knowing: every polling loop in `maestro/daemon-port` and `react-native/metro` is deadline-bounded and abort-aware; no test file in the slice has fewer assertions than test cases; replay trace events pass through `redactDiagnosticData` and `buildDisplayPositionals`; the target-annotation writer does enforce the 4096-byte payload cap the parser rejects on.

## Findings

### REPLAY-1: Recorded literal `${...}` text is re-interpolated on replay (writer never emits the `\${` escape the resolver supports)
- Category: broken
- Severity: medium     Confidence: high
- Evidence: `packages/ad-script/src/internal/vars.ts:187-190` (resolver honours `\${` as an escape) and `:224-235` (`resolveReplayAction` interpolates every positional and every string flag); `packages/ad-script/src/internal/script-utils.ts:195-211` (`formatScriptArg`/`formatScriptStringLiteral` only JSON-quote); `git grep -F '\\${' packages/**/*.ts` finds no writer that escapes. A recorded `type "cost ${amount}"` or `fill @e1 "${name}"` replays as `Unresolved variable ${amount}` (vars.ts:209-212), or silently substitutes if a same-named var exists.
- Fix: escape `${` to `\${` when the writer serialises recorded literal text (in `formatScriptArg` callers for typed text and selector/label positionals in `packages/daemon/src/core/session-script-writer.ts` and `packages/ad-script/src/internal/script-utils.ts`), but leave the `--record-as` placeholder (`recordedInputPlaceholder`) unescaped. Add a round-trip test.
- Effort: S
- Model: opus (touches the record/replay contract and the `--record-as` placeholder path)
- Verify: new round-trip case in `packages/ad-script/src/internal/__tests__/script.test.ts` plus `vars.test.ts`: write an action whose text is `a ${b}`, parse, resolve with empty scope, expect the original text.

### REPLAY-2: `runScript` blocks the daemon event loop for up to 30 s per call (sync `vm` + `spawnSync` HTTP)
- Category: broken
- Severity: medium     Confidence: high
- Evidence: `packages/maestro/src/daemon-port/run-script-execution.ts:26-29` (`vm.runInNewContext` sync, 30 s timeout) and `:104-108` (`runCmdSync(process.execPath, …, { timeoutMs: 30_000 })` for every `http.post`); called inline from the daemon's async operation at `packages/maestro/src/daemon-port/daemon-runtime-port.ts:356-365`. While it runs, no other session request, cancellation signal, or progress event is serviced. The `vm` timeout cannot fire during the nested sync spawn, so one script can hold the loop past 30 s.
- Fix: run the script in a worker thread or child process (the child entry `internal/run-script-http-child` pattern already exists) and await it with the request `AbortSignal`; keep the sync `http.post` semantics inside that isolated process.
- Effort: M
- Model: opus (process/concurrency design, trust boundary)
- Verify: a test that starts `executeRunScriptFile` against a slow loopback server and asserts a concurrent timer/abort fires before it returns.

### REPLAY-3: `runScript` HTTP responses over ~1 MiB fail with a spawn buffer error, contradicting the declared 8 MiB cap
- Category: broken
- Severity: medium     Confidence: high
- Evidence: `packages/maestro/src/daemon-port/run-script-http.ts:7` declares `MAX_RUN_SCRIPT_HTTP_RESPONSE_BYTES = 8 * 1024 * 1024`; the response is returned over the child's stdout through `runCmdSync` (`run-script-execution.ts:104-108`) with no `maxBuffer`, and `packages/host-kit/src/internal/exec.ts:421` only sets `maxBuffer` when given, so Node's `spawnSync` default (1 MiB) applies. A 2 MiB body (plus JSON escaping) surfaces as a generic command failure, not the typed "exceeded N bytes" error. The local (trusted) path has no cap at all (`run-script-http.ts:36-37`).
- Fix: pass `maxBuffer` sized from the cap (allowing for JSON escaping) in `runHttpRequestSync`, and apply the same byte cap to `executeLocalRequest`.
- Effort: S
- Model: sonnet
- Verify: extend `packages/maestro/src/daemon-port/__tests__/run-script-http.test.ts` with a 2 MiB response through the child path.

### REPLAY-4: `eraseText.charactersToErase` has no upper bound; a large value allocates a giant string or throws a raw `RangeError` in the daemon
- Category: broken
- Severity: medium     Confidence: high
- Evidence: `packages/maestro/src/internal/program-ir-values.ts:232-233` constrains only `{ integer: true, positive: true }` (up to `MAX_SAFE_INTEGER`); `packages/maestro/src/daemon-port/daemon-runtime-port.ts:276-282` does `'\b'.repeat(input.charactersToErase ?? 50)`. `eraseText: 500000000` builds a 500 MB string and sends it to `typeText`; `eraseText: 600000000` throws `RangeError: Invalid string length`, which is not an `AppError` and loses source context. Remote (untrusted) flows can submit this.
- Fix: add a `max` to `NumericScalarConstraints` and cap `eraseText`/`eraseText.charactersToErase` (for example a few thousand) in both `validateNumericScalar` and `resolveNumeric` (`engine-flow.ts:29-60`).
- Effort: S
- Model: sonnet
- Verify: parser test in `packages/maestro/src/internal/__tests__/program-ir-parser.test.ts` expecting `INVALID_ARGS` for an over-cap value, literal and `${VAR}` forms.

### REPLAY-5: `actionSourcePaths` is threaded through three packages but no producer ever sets it
- Category: unneeded
- Severity: medium     Confidence: high
- Evidence: declared at `packages/ad-script/src/internal/script.ts:59-64` ("A Maestro action inlined from a `runFlow` include carries the include's resolved path"), but `parseReplayScriptDetailed` returns `{ actions, actionLines }` only (`script.ts:245` in the file's own numbering) and the Maestro engine no longer compiles to `SessionAction[]` (no `actionSourcePaths` hit under `packages/maestro`). Still plumbed through `packages/ad-replay/src/internal/inspect.ts:35,86,97`, `plan-digest.ts:27-46` (always hashes `path: null`), `runtime-port-types.ts:352`, `step-loop.ts:217`, `packages/replay-port/src/daemon-port/native-command.ts:107,131,154`, `session-replay-runtime-plan.ts:78,121,137`, `session-replay-runtime-engine-adapter.ts:139,231,353,404`, and the `sourcePath` param of `session-replay-action-runtime.ts:38`. This is a superseded migration path.
- Fix: delete the field and every `?.[index] ?? ctx.resolved` fallback; keep `source.path` out of the digest input or bump nothing (it is constantly `null`, so removing the key changes the digest: gate that behind the existing digest test and accept the change, or keep a literal `path: null`).
- Effort: S
- Model: sonnet (mechanical; note the digest-stability decision)
- Verify: `git grep actionSourcePaths` returns nothing; `packages/ad-replay/src/internal/__tests__/plan-digest.test.ts` and `step-loop.test.ts` pass.

### REPLAY-6: Maestro `launchApp.arguments` map is passed as bare `key value` pairs, not the `-key value` launch arguments upstream Maestro produces
- Category: inconsistent
- Severity: medium     Confidence: medium
- Evidence: `packages/maestro/src/daemon-port/daemon-runtime-port-support.ts:90-101` returns `[key, String(entry)]` for the map form; test `daemon-runtime-port.test.ts:125` pins `['seed', '7']`. Upstream Maestro prefixes iOS launch-argument keys with `-` unless already present, which is what `UserDefaults`/`ProcessInfo` parsing relies on. Confidence is medium because the upstream behaviour is from memory, not from the pinned corpus; `test/conformance/expected-divergence.ts` records no divergence for it.
- Fix: confirm against the pinned upstream version in `scripts/maestro-conformance/pinned-upstream.json`; then either prefix `-` for map keys or record the difference in `expected-divergence.ts` and the support matrix.
- Effort: S
- Model: opus (device behaviour, needs upstream check)
- Verify: conformance layer `pnpm gate maestro-conformance` (lead-run) plus the updated unit expectation.

### REPLAY-7: Maestro flows accept mixed-case variable names, but `-e` and `AD_VAR_*` reject anything that is not UPPER_SNAKE
- Category: inconsistent
- Severity: medium     Confidence: high
- Evidence: the Maestro context resolves `${[A-Za-z_][A-Za-z0-9_.]*}` (`packages/maestro/src/internal/engine-context.ts:121`) and flow `env:` keys are unrestricted, yet the Maestro backend builds its overrides with the `.ad` helpers (`packages/maestro/src/replay-backend/session-replay-maestro-runtime.ts:326-331`), which throw `Invalid -e key … keys must be uppercase` (`packages/ad-script/src/internal/vars.ts:85-90`) and silently drop non-uppercase `AD_VAR_` names (`vars.ts:68`). A flow using `${username}` cannot be overridden from the CLI, although the support matrix says "CLI -e KEY=VALUE wins over both".
- Fix: give the Maestro backend its own key grammar (matching `engine-context.ts`) for `-e`/shell env, or document the uppercase restriction in `support-matrix.ts` and the docs page it is synced with.
- Effort: S
- Model: sonnet
- Verify: `packages/daemon/src/sessions/__tests__/replay-maestro/*` case with `replayEnv: ['username=x']`.

### REPLAY-8: `repeat` with `while` and no `times` has no iteration or time ceiling
- Category: broken
- Severity: medium     Confidence: medium
- Evidence: `packages/maestro/src/internal/replay-plan-step-execution.ts:239-249` sets `maxIterations = Number.POSITIVE_INFINITY`; `repeat.times` itself is capped only at `MAX_SAFE_INTEGER` (`program-ir-values.ts:239`). `retry` is capped (`compatibility-policy.ts:13`), `repeat` is not. The loop does yield and checks cancellation, so it ends only on caller cancel or an outer request timeout; `test` attempts have no default timeout (see REPLAY-19).
- Fix: add a `repeatMaxIterations` (and/or wall-clock budget) to `MAESTRO_COMPATIBILITY_PRESETS.control` and fail with a typed `maestroTestFailure` when exceeded.
- Effort: S
- Model: opus (compatibility policy decision)
- Verify: engine test in `packages/maestro/src/internal/__tests__/engine.test.ts` with `while: { true: true }`.

### REPLAY-9: Suite-level failures drop the typed error `details`/`hint`
- Category: broken
- Severity: low     Confidence: high
- Evidence: `packages/replay-test/src/internal/session-test.ts:134-137` returns only `{ code, message }` from the caught `AppError`, and `packages/replay-port/src/daemon-port/test-command.ts:301-303` rebuilds the response with `errorResponse(code, message)`. Errors thrown during planning, such as `DEVICE_NOT_FOUND` from shard resolution (`session-test-shard-devices.ts:86-91,153-155`) or discovery `INVALID_ARGS`, lose `details`, `hint`, `diagnosticId`. Same shape at `test-command.ts:193-196`.
- Fix: carry the normalized error (`normalizeError`) through `ReplayTestSuiteOutcome` and return `{ ok: false, error }` unchanged.
- Effort: S
- Model: sonnet
- Verify: `packages/replay-test/src/internal/__tests__/session-test-runtime.test.ts` case asserting `details` survive a thrown `resolveShardTargets`.

### REPLAY-10: `healed` result field is always `0`
- Category: unneeded
- Severity: low     Confidence: high
- Evidence: the only producers hard-code it: `packages/replay-port/src/daemon-port/native-command.ts:237` and `packages/maestro/src/replay-backend/session-replay-maestro-response.ts:33`. It is still carried by `packages/replay-port/src/daemon-port/session-test-outcome.ts:35`, `packages/replay-test/src/internal/session-test-types.ts:139`, `session-test-attempt.ts:345`, written to artifacts as `healed: 0` (`session-test-artifacts.ts:81`), and declared in `packages/contracts/src/replay.ts:64,98` and the output schema `packages/command-surface/src/replay/index.ts:121,130`. It is a leftover of `replay -u`, which the docs now describe as "accepted and does nothing" (`website/docs/docs/commands.md`).
- Fix: remove the field from the engine/test types and artifacts; it is part of the public result schema, so drop it there only with an explicit decision (AGENTS.md compat rule).
- Effort: S
- Model: sonnet
- Verify: `git grep -n "healed:"` shows no producer; replay/test suites pass.

### REPLAY-11: `.ad` header metadata is strict about duplicates but silently drops invalid values, and matches keys inside the quoted device name
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence: `packages/ad-script/src/internal/script.ts` `readReplayScriptMetadata`: duplicate/conflicting keys throw (`assignReplayMetadataValue`), but `context platform=andriod`, `timeout=0`, `timeout=5s` (read as `5` by `(\d+)`), and `retries=-1` are ignored without error, so a typo silently removes the platform filter or the timeout. The regexes run over the whole line, and the writer emits `device="<name>"` on that line (`packages/daemon/src/core/session-script-writer.ts:456-459`), so a device named `Lab timeout=5` sets a 5 ms timeout.
- Fix: tokenize the `context` line with the script tokenizer (`tokenizeReplayLine`), read `key=value` tokens only, and throw `INVALID_ARGS` for an unknown or out-of-range value of a known key.
- Effort: S
- Model: sonnet
- Verify: new cases beside `script.test.ts:583-660`.

### REPLAY-12: Three different "is this a coordinate" predicates for `fill`/`click` targets
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence: parser `isNumericToken` uses `!Number.isNaN(Number(token))` (`packages/ad-script/src/internal/script.ts`, end of file; accepts `0x10`, `1e3`, `Infinity`); `inferFillText` repeats that rule without the empty-token guard (`recorded-input.ts:66-72`, so `''` counts as numeric); the writer and the divergence label use `NUMERIC_ARG_RE = /^-?\d+(\.\d+)?$/` (`script-utils.ts:34,256-262`). For `fill 0x10 0x20 hi` the parser builds a coordinate fill while `formatDivergenceActionLabel` reports `0x10` as a selector target.
- Fix: export one `isScriptCoordinateToken` from `script-utils.ts` (the strict regex) and use it in all three places.
- Effort: S
- Model: sonnet
- Verify: `script-utils.test.ts` / `script.test.ts` cases for `1e3`, `0x10`, `Infinity`, `''`.

### REPLAY-13: Source-location suffixing decides by matching error message text
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence: `packages/maestro/src/internal/replay-plan-step-execution.ts:378-386` skips adding `(path:line N)` when `/\bline \d+\b/.test(error.message)`. Any failure whose message happens to contain "line 2" (for example an element label or a selector rendered in the message) loses its source context. AGENTS.md: "Use typed reasons and details for behavior. Do not match error text."
- Fix: mark located errors with a typed detail (for example `details.maestroSource`) when `invalidAt`/`commandFailure` add the location, and test that instead.
- Effort: S
- Model: sonnet
- Verify: `packages/maestro/src/internal/__tests__/replay-plan-step-execution.test.ts` case with a selector text containing `line 3`.

### REPLAY-14: Resume validation is implemented twice with diverging user-facing text
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence: `packages/ad-replay/src/internal/resume.ts:68-74,118-133,181-188` and `packages/maestro/src/internal/replay-plan-resume.ts:13-31` each implement the `--from`/`--plan-digest` pairing, range and digest checks. Two messages are byte-identical copies; the stale-digest message differs (ad-replay explains the cause and says "Run a fresh full replay to get a new digest", Maestro says only "does not match the current plan digest"). Both digests also hash through separate canonical builders (`plan-digest.ts`, `replay-plan-digest.ts`).
- Fix: move the three format-neutral checks and their messages to one owner both engines already depend on (`@agent-device/ad-script` or `contracts/replay`), keeping the engine-specific rules (record-and-heal tail, opaque-step refusal) local.
- Effort: S
- Model: sonnet
- Verify: `packages/ad-replay/src/internal/__tests__/resume.test.ts` and `packages/maestro/src/internal/__tests__/replay-plan.test.ts`.

### REPLAY-15: `runScript` exposes only `http.post`; the `GET` method and trust default are dead or fail-open surface
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence: `packages/maestro/src/daemon-port/run-script-execution.ts:62-65` defines only `http.post`, while `RunScriptHttpRequest.method` is `'GET' | 'POST'` (`run-script-http.ts:9-10`) and nothing can send `GET`. Separately `assertMaestroScriptsTrusted` treats an omitted flag as trusted (`engine-flow.ts:142-143`, `trustedScripts !== false`); both production callers pass it explicitly (`run-script-execution.ts:25`, `session-replay-maestro-runtime.ts:136`), so a future caller that forgets it gets JavaScript execution.
- Fix: narrow `method` to `'POST'` (or add `http.get` and document it), and make `trustedScripts` a required boolean on `MaestroEngineOptions`/`MaestroExecutionOptions`.
- Effort: S
- Model: sonnet
- Verify: `tsc` (required field) and `run-script-http.test.ts`.

### REPLAY-16: Legacy snapshot tokens and parse/write asymmetry in the `.ad` grammar
- Category: unneeded
- Severity: low     Confidence: high
- Evidence: `packages/ad-script/src/internal/script.ts` snapshot branch skips `-c` and `--backend <value>` ("Backward compatibility: ignore legacy snapshot backend token"); no writer emits either (`appendSnapshotActionScriptArgs`, `script-utils.ts:347-356`) and no test or doc references them. The same branch parses `--force-full` but the writer never emits it, and any other token is dropped silently. `packages/ad-replay/src/internal/inspect.ts:74-80` also keeps a rejection for the removed JSON replay payload. AGENTS.md: "During a migration, remove superseded paths."
- Fix: delete the `-c`/`--backend` branches; either write `--force-full` or stop parsing it; throw `INVALID_ARGS` for unknown snapshot tokens.
- Effort: S
- Model: sonnet
- Verify: `script.test.ts:166-200` round-trip cases.

### REPLAY-17: `tmp-dir.fixtures.ts` copies kept under `fallow-ignore` although `@agent-device/test-kit` exports the same helpers
- Category: unneeded
- Severity: low     Confidence: high
- Evidence: `packages/maestro/src/tmp-dir.fixtures.ts` and `packages/replay-test/src/tmp-dir.fixtures.ts` are byte-identical (md5 `c7bc3b72…`, also shared with three provider packages); `packages/replay-port/src/tmp-dir.fixtures.ts` is a third copy. Each carries `// fallow-ignore-next-line code-duplication`. `packages/test-kit/src/index.ts:132` exports `mkdtempForTest`/`mkdtempForTestSync`, and `replay-port` already lists test-kit as a devDependency (`packages/replay-port/package.json`). AGENTS.md: "Resolve a gate failure at the reported invariant. Do not suppress it."
- Fix: import from `@agent-device/test-kit` in the 11 test files that use the local copy, add the devDependency to `maestro` and `replay-test`, delete the three files.
- Effort: S
- Model: sonnet
- Verify: `git grep tmp-dir.fixtures packages/{maestro,replay-port,replay-test}` is empty; affected tests pass.

### REPLAY-18: Duplicate explicit shard devices run two shards on one device
- Category: broken
- Severity: low     Confidence: medium
- Evidence: `packages/replay-port/src/daemon-port/session-test-shard-devices.ts:141-157` maps each `--device a,b` selector to the first matching inventory entry with no de-duplication, and `:86-92` only checks the count. `--device Pixel,Pixel --shard-split 2` yields two shards with the same `serial`, which `runReplayTestShards` runs concurrently (`packages/replay-test/src/internal/session-test.ts:249-251`). Confidence is medium because a downstream device lease may refuse the second session.
- Fix: reject repeated resolved device ids with `INVALID_ARGS` in `resolveExplicitShardDevices`.
- Effort: S
- Model: sonnet
- Verify: new case in `packages/replay-port/src/daemon-port/__tests__/` for duplicate selectors.

### REPLAY-19: A `test` attempt has no timeout unless the caller or the script sets one
- Category: broken
- Severity: low     Confidence: low
- Evidence: `packages/replay-test/src/internal/session-test-runtime.ts:100-112` races a timer only when `timeoutMs` is a number, otherwise `await replayPromise`; the value comes from `--timeout` or `context timeout=` only (`session-test-discovery.ts:192-197`, `test-command.ts:470`). `replay` documents a 60000 ms default (`packages/command-surface/src/replay/index.ts:68-70`); `test` documents none (`:99`). Not traced: whether each nested dispatch has its own bound that makes this moot.
- Fix: apply the documented replay default per attempt, or state in help that `test` is unbounded without `--timeout`.
- Effort: S
- Model: opus (timeout envelope is cross-module)
- Verify: `session-test-runtime.test.ts` case with a never-resolving `runReplay` and no `timeoutMs`.

### REPLAY-20: Retry cap is defined twice and script metadata over the cap is clamped silently
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence: `packages/replay-test/src/internal/session-test-discovery.ts:11,199-206` (`MAX_REPLAY_TEST_RETRIES = 3`, `Math.min`) duplicates the flag bound `max: 3` in `packages/command-registry/src/flag-definitions-workflow.ts:107-112`. `--retries 7` is rejected by the CLI, while `context retries=7` in a script is accepted by `readReplayScriptMetadata` and silently run as 3.
- Fix: export one constant (contracts) used by the flag definition, the clamp, and a metadata range check that throws.
- Effort: S
- Model: sonnet
- Verify: `session-test-discovery.test.ts` and the flag-definition tests.

### REPLAY-21: `waitForAnimationToEnd` retries a failing screenshot capture back-to-back with no delay until the deadline
- Category: inefficient
- Severity: low     Confidence: medium
- Evidence: `packages/maestro/src/daemon-port/wait-for-animation-to-end.ts:31-35` loops immediately; `capturePairMatches` returns `false` both for "frames differ" and for a failed capture or failed comparison (`:44-52`, `maestro-screenshot-comparison.ts:91-104`). A capture that fails fast is retried continuously for the 15 s default (`compatibility-policy.ts:20`), and the result is indistinguishable from "animation never settled".
- Fix: return a typed tri-state from `capturePairMatches`; on capture/compare failure sleep `pollIntervalMs` (or fail after N consecutive errors) instead of spinning.
- Effort: S
- Model: sonnet
- Verify: unit test with a `capture` that always rejects, asserting a bounded call count under a fake clock.

### REPLAY-22: Flow config `tags` is parsed and validated but nothing reads it
- Category: unneeded
- Severity: low     Confidence: high
- Evidence: `packages/maestro/src/internal/program-ir-parser.ts:78,87-88,97` and `program-ir.ts:308`; `grep -rn "tags" packages/maestro/src` (non-test) has no other hit, and `test` has no tag filter. It is accepted silently, so a user may expect Maestro's include/exclude-tags behaviour.
- Fix: keep accepting the key for upstream compatibility but stop storing it, and list it as metadata-only in `support-matrix.ts`; or implement a tag filter.
- Effort: S
- Model: sonnet
- Verify: `program-ir-parser.test.ts`; support-matrix sync test `src/cli/parser/__tests__/args-maestro-support-matrix.test.ts`.

### REPLAY-23: Comment volume and change-history narration in `ad-replay`, `replay-port`, `ad-script`
- Category: unneeded
- Severity: low     Confidence: high
- Evidence: comment lines are 39% of non-blank production lines in `ad-replay` (848/2124), 21% in `replay-port`, 19% in `ad-script`, versus 2% in `maestro` and 4% in `react-native`. `packages/ad-replay/src/index.ts` is 81 comment lines for 19 of code and narrates review passes and a deleted file (`src/daemon/ad-replay-facade-types.ts`, "since deleted"); `runtime-port-types.ts` is 186/359; `ad-script/src/internal/open-script.ts:10-24` recounts where two former copies lived. `target-annotation-serde.ts` carries six "Mutation-lane note" blocks that declare their own guards provably redundant (`:89-92,103-108,127-131,243-248,376-379,417-422`). About 180 comment lines in these three packages cite issue numbers or review rounds. AGENTS.md: "Write comments only for public APIs, tool directives, or constraints that code cannot show."
- Fix: reduce to API docs and non-obvious constraints; delete history; either remove the self-declared redundant guards or drop the notes.
- Effort: M
- Model: sonnet
- Verify: `pnpm format`; no behaviour change (lead-run gates).

### REPLAY-24: `scrollRegion.id` validation errors name the wrong field
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence: `packages/ad-script/src/internal/target-annotation-serde.ts:395` calls `parseOptionalIdentifierField(record.id, 'id')` (the parameter is typed `field: 'id'` at `:324`), so a bad or oversized `scrollRegion.id` reports `target-v1 "id" must be a string` / `"id" exceeds the 256-byte field cap`, pointing at the top-level id. Sibling fields use `scrollRegion.role` / `scrollRegion.label`.
- Fix: widen the parameter to `string` and pass `'scrollRegion.id'`.
- Effort: S
- Model: sonnet
- Verify: case in `target-annotation-serde.test.ts`.

### REPLAY-25: `replay-port` publishes 30 subpath exports; 12 have no importer outside the package
- Category: unneeded
- Severity: low     Confidence: medium
- Evidence: `packages/replay-port/package.json` exports; `git grep "@agent-device/replay-port/<name>'"` outside the package returns nothing for `repair-hint`, `session-replay-report-action`, `session-replay-runtime-artifacts`, `session-replay-runtime-failure-response`, `session-replay-suggestion-ranking`, `session-replay-trace`, `session-replay-vars`, `session-replay-video-recording`, `session-test-outcome`, `session-test-shard-devices`, `target-classification`, `target-token`. They are consumed only by the package importing itself by name (for example `session-replay-divergence.ts:26,36,37`, `test-command.ts:24,45,49,54`). Confidence is medium: the self-import-by-specifier style may be a layering convention.
- Fix: use relative imports for intra-package edges and remove the 12 entries, unless `scripts/layering` requires the specifier form (check before changing).
- Effort: S
- Model: sonnet
- Verify: layering scan and `tsc` (lead-run).

### REPLAY-26: Directory suite order is raw filesystem order, including for native `.ad` suites
- Category: inconsistent
- Severity: low     Confidence: medium
- Evidence: `packages/replay-port/src/source-discovery.ts:36-40,93-110` sorts glob matches but leaves `opendirSync` order for directory inputs; the tests pin this as Maestro compatibility (`__tests__/source-discovery.test.ts:106,141` "preserves Maestro directory filesystem order"). The same path serves `.ad`-only suites, so `test ./suite` order, the `--shard-split` assignment (`session-test-sharding.ts:66`, index modulo), and per-case session numbering differ between filesystems.
- Fix: sort directory entries by name when no Maestro backend is requested; keep filesystem order only under `--maestro`.
- Effort: S
- Model: sonnet
- Verify: `source-discovery.test.ts` case creating files in reverse order for an `.ad` directory.
