## Coverage

Slice REPLAY2: the parts of `packages/maestro`, `packages/replay-port`, `packages/react-native` that the first pass (`maestro-replay-rn.md`) did not reach. Findings from that report are not repeated; where a finding here extends one, it says so.

- Read fully (production):
  - `maestro`: `runtime-selector-resolution.ts`, `runtime-targets.ts`, `runtime-target-ranking.ts`, `runtime-target-position.ts`, `runtime-target-policy.ts`, `runtime-clickability.ts`, `selector-regex.ts`, `selector-vocabulary.ts`, `selector-relations.ts`, `snapshot-policy.ts`, `shared.ts`, `export-flow.ts`, `export-navigation.ts`, `export-points.ts`, `export-yaml.ts`, `export-types.ts`, `program-ir-selector-parser.ts`, `program-ir-selector-options.ts`, `facade-execution.ts`, `facade-runtime-port.ts`, `runtime-port-geometry.ts`, `runtime-port-observation.ts`, `runtime-port-commands.ts` (lines 150-551), `progress.ts`, `compatibility-policy.ts`, `daemon-port/daemon-runtime-tap.ts`, `daemon-port/daemon-runtime-public-operation.ts`, `daemon-port/wait-for-animation-to-end.ts`, `replay-backend/replay-maestro-backend.ts`, `replay-backend/session-replay-maestro-failure.ts`, `replay-backend/session-replay-maestro-observer.ts`, `index.ts`, `package.json`.
  - `replay-port`: `session-replay-divergence.ts`, `session-replay-divergence-publication.ts`, `session-replay-target-verification.ts`, `target-classification.ts`, `target-token.ts`, `session-replay-heal.ts`, `session-replay-video-recording.ts`, `repair-hint.ts`, `session-replay-suggestion-ranking.ts`, `session-replay-runtime-failure.ts`, `session-replay-runtime-failure-response.ts`, `replay-backend-failure.ts`, `session-replay-dispatch-narrowing.ts`, `replay-dispatch-envelope.ts`, `replay-script-selection.ts`, `replay-session-binding.ts`, `replay-backend-registry.ts`, `replay-backend-host.ts`, `replay-backend-declarations.ts`, `session-test-infrastructure.ts`, `session-test-outcome.ts`, `session-replay-runtime-artifacts.ts`, `session-replay-vars.ts`, `script-source.ts`, `session-replay-test-policy.ts`, `session-replay-report-action.ts`.
  - `react-native`: `companion/client-companion-tunnel.ts`, `client-metro-companion.ts`, `companion-tunnel.ts`, `client-companion-tunnel-contract.ts`, `metro-tunnel-messages.ts`, `react-devtools/metro-inspector.ts`, `react-devtools-connection.ts`, `react-profile-command.ts`, first third of `react-devtools-inspect-command.ts`, `package.json`, `index.ts` exports.
  - Conformance: `test/conformance/verify.ts`, `verify.test.ts`, `expected-divergence.ts`, `harness.ts`, the CI and `package.json` wiring for all conformance tests.
- Skimmed / grep-probed: `daemon-port/daemon-runtime-port.ts` (lines 255-372), `daemon-runtime-port-observation.ts` (lines 150-320), `react-devtools-runtime.ts` (header only; the 420-line in-app ES5 source was not audited), `react-profile-analysis.ts`/`react-profile-format.ts` (index and sort use only); all test files in the three packages by script (duplicate titles, assertion-free cases, `.skip`/`.only`, weak matchers, fixture usage); three test files read in full (`maestro/src/index.test.ts`, `progress.test.ts`, `export-flow-label-projection.test.ts`).
- Not reached: `maestro` `replay-plan-steps.ts`, `replay-plan-execution.ts`, `replay-plan-compilation.ts`, `engine-types.ts`, `runtime-port-types.ts`, `daemon-runtime-port-support.ts`, `daemon-runtime-port-snapshot-source.ts`, `maestro-screenshot-comparison.ts` beyond the first pass; `test/conformance/conformance-normalize.ts`, `layer2-tree.ts`, `differential/**` bodies; `react-native` `react-profile-renders.ts`, `react-component-tree.ts`, `react-component-inspect.ts`, `metro-session-hints.ts`, `metro-reload-endpoints.ts`; the bodies of most test files.
- Rough coverage of the slice this pass: ~60% of the production lines the first pass left unread (maestro ~65%, replay-port ~95%, react-native ~45%); tests ~10% read, 100% script-scanned.

Runtime probes: `exportReplayActionsToMaestro` and `formatMaestroCommandProgress` were run once through `node --experimental-strip-types` with a throwaway script (deleted afterwards; `git status` is clean) to confirm REPLAY2-3, REPLAY2-6, REPLAY2-7 and REPLAY2-16.

Negative results: the conformance `checkLayer2` "no live constant" path is not a hole (`verify.test.ts:163-171` requires every reference-only vector to be declared); `conformance-selector-projection.test.ts` is not orphaned (it runs under vitest, `vitest.config.ts:139`); post-dispatch target-binding failures carry no stale refs (`candidateNodes: []` at `ad-replay/src/internal/verify-dispatch.ts:271,342`); the script scan found no duplicate test titles across files, no `.skip`/`.only`, and no assertion-free test once local assert helpers are counted; `packages/react-native/src/index-metro.test.ts` and `packages/client/src/__tests__/index-metro.test.ts` share no test titles.

## Findings

### REPLAY2-1: `test` classifies a failure as infrastructure by substring-matching the error message, which stops retries for ordinary failures
- Category: broken
- Severity: medium     Confidence: high
- Evidence: `packages/replay-port/src/daemon-port/session-test-infrastructure.ts:6-13,45-48` lower-cases `code + message` and tests it for `'device is offline'`, `'device offline'`, `'device unauthorized'`, `'failed to start daemon'`, `'runner did not accept connection'`, `'xcodebuild exited early'`. The message it sees is the divergence message, which embeds the action label and the cause text (`session-replay-runtime-failure-response.ts:110-113`: `Replay failed at step N (<action label>): <cause>`). A step such as `wait text "Device offline"` or `click label="Device is offline"` that fails for any reason is tagged `infrastructure: true` (`session-test-outcome.ts:24`), and `shouldStopReplayTestAttempts` then skips the remaining `--retries` (`packages/replay-test/src/internal/session-test-attempt.ts:261-273`). The help text promises the tag appears "only when the owning runtime classified a device, runner, boot, or transport failure" (`src/commands/schema/cli-help.ts:156`). It also violates AGENTS.md: "Use typed reasons and details for behavior. Do not match error text."
- Fix: delete `REPLAY_INFRASTRUCTURE_FAILURE_MESSAGE_PATTERNS` and `hasInfrastructureFailureMessage`; keep the typed `details.reason`/`details.recovery` path. For each of the six conditions, make the producer set a typed reason (the boot-failure reasons already exist in `@agent-device/contracts/boot-failure`) and add it to `isInfrastructureBootFailureReason` or its sibling. Files: `session-test-infrastructure.ts`, the producers of those six messages, `contracts/src/boot-failure.ts`.
- Effort: M
- Model: opus (cross-module: the producers are in daemon/runner/device code)
- Verify: new case in `packages/replay-port/src/daemon-port/__tests__/session-test-infrastructure.test.ts`: a `REPLAY_DIVERGENCE` response whose message is `Replay failed at step 2 (wait text "Device offline"): timeout` must return `false`.

### REPLAY2-2: Divergence `suggestions[].ref` and `targetBinding.candidates[].ref` are returned without being in the published ref scope
- Category: broken
- Severity: medium     Confidence: medium
- Evidence: `session-replay-divergence-publication.ts:58-62` publishes only `screen.refs.map((entry) => entry.ref)`; the daemon then authorizes exactly that set (`packages/daemon/src/execution/internal-observation.ts:114` `markSessionPartialRefsIssued(session, refs)`; `core/ref-frame.ts:149` "activate a frame that authorizes ONLY `scope`"). `screen.refs` is a filtered, ranked, capped subset: at most 20 (`session-replay-divergence.ts:420,511`), minus chrome and covered nodes, then cut again by response level (`ad-replay/src/replay-divergence.ts:117-120,133-134`). Suggestions and target-binding candidates take `node.ref` from the full capture with no such filter (`session-replay-divergence.ts:671`, `session-replay-target-verification.ts:516`). In the empty-screen branch (`publication.ts:44-52`) nothing is published, yet `bounded` is returned with suggestion refs intact, although the same file strips those refs when publication fails (`:70-93`). No test covers a suggestion ref outside `screen.refs` (`session-replay-divergence-publication.test.ts` only uses `suggestions: []` or the stripped case). Confidence is medium because the daemon-side rejection of an out-of-scope ref was read, not executed.
- Fix: in `boundReplayDivergenceForSession`, after bounding, drop `ref` from every suggestion and target-binding candidate whose ref is not in the projected `screen.refs` (or publish the union when it fits the cap). Reuse `suppressUnpublishedDivergenceRefs`' mapping for the per-entry strip.
- Effort: S
- Model: opus (ref-authority contract, ADR 0014)
- Verify: new case in `packages/daemon/src/sessions/__tests__/replay-divergence/session-replay-divergence-publication.test.ts`: a divergence whose suggestion ref is not in `screen.refs` returns that suggestion without `ref`; and one with `screen.refs: []` plus a suggestion ref returns no ref.

### REPLAY2-3: `replay export` turns `wait stable`, `wait @ref`, and a bare `wait text` into waits for literal on-screen text
- Category: broken
- Severity: medium     Confidence: high
- Evidence: `packages/maestro/src/internal/export-flow.ts:261-315` handles only `<ms>`, `absent`, and `text <q>`, then passes the first positional to `resolveSelector`, which returns non-selector words unchanged (`packages/selectors/src/index.ts:124-127`). The wait grammar also has `stable [quietMs] [timeoutMs]` and `@ref` (`packages/command-registry/src/wait-positionals.ts:36-39`). Probe output: `wait stable` exports `extendedWaitUntil: { visible: stable, timeout: 17000 }`; `wait stable 500 3000` exports `visible: stable, timeout: 3000`; `wait @e3` exports `visible: "@e3"`; `wait text` exports `visible: text`. No warning is produced, and no export test covers these forms.
- Fix: in `convertWaitAction`, parse with `parseWaitPositionals` (already the grammar owner) and switch on `kind`: `stable` to `waitForAnimationToEnd` with a warning (or unsupported), `ref` to unsupported, empty `text` to unsupported.
- Effort: S
- Model: sonnet
- Verify: cases in `src/cli/commands/__tests__/replay-maestro-export.test.ts` for `wait stable`, `wait @e3`, `wait text`.

### REPLAY2-4: `ensureCompanionTunnel` is an unlocked read-check-spawn-write, so two concurrent callers start two companions and one is orphaned
- Category: broken
- Severity: medium     Confidence: medium
- Evidence: `packages/react-native/src/companion/client-companion-tunnel.ts:441-466` reads the state file, decides to spawn, then writes the state. `touchCompanionState` (`:462`) creates an empty file that `readCompanionState` treats as "no state" (`:140` `JSON.parse('')` throws, returns `null`), so it does not exclude a second caller. Two CLI processes for the same profile both spawn; the later `writeCompanionState` wins and the earlier pid is no longer tracked, so `stopCompanionTunnel` never stops it. The comment at `:455-456` states the invariant ("keeps one bridge scope down to one companion") that this breaks. Confidence is medium: the worker's own lease check may end the orphan, which was not traced.
- Fix: take an exclusive lock for the ensure/stop critical section (create the sentinel with `fs.openSync(path, 'wx')` and treat `EEXIST` with a live owner as "wait and re-read"), or reuse a host-kit file lock if one exists.
- Effort: M
- Model: opus (process lifecycle, concurrency)
- Verify: test in `packages/react-native/src/companion/client-metro-companion.test.ts` that calls `ensureCompanionTunnel` twice concurrently with a stubbed spawn and asserts one spawn and one tracked pid.

### REPLAY2-5: A CDP call sent after the debugger socket closed waits the full 30 s timeout
- Category: broken
- Severity: low     Confidence: medium
- Evidence: `packages/react-native/src/react-devtools/metro-inspector.ts:206-212` rejects pending calls once, on the `close` event. `#send` (`:271-290`) never checks socket state: a call issued after that event registers a new pending entry and a 30 s timer (`EVALUATE_TIMEOUT_MS`, `:5`), and `WebSocket.send` on a closed socket discards silently. Multi-call commands (`stopProfile` calls `stop` then `describeProps`, `react-profile-command.ts:197,217`; `withAppRuntime` evaluates the runtime source then the action) hit this when the app reloads mid-command: the user waits 30 s and gets "did not answer in time" instead of "closed the debugger connection". Confidence is medium on the exact `send` behaviour of Node's WebSocket in `CLOSED` state.
- Fix: keep a `#closed` flag set in the `close` listener; reject at the top of `#send` with the existing "closed the debugger connection" error.
- Effort: S
- Model: sonnet
- Verify: case in `metro-inspector.test.ts`: close the server socket, then `evaluate` must reject immediately under fake timers.

### REPLAY2-6: Exported tap/swipe points use a looser numeric test than the Maestro parser accepts
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence: `export-flow.ts:491-493` `isNumber` is `Number.isFinite(Number(value))` and `formatMaestroPoint` (`export-points.ts:1-3`) joins the raw strings. The package's own parser accepts only `^\s*(\d+)\s*,\s*(\d+)\s*$` (`program-ir-selector-parser.ts:187`). Probe: `click 0x10 0x20` exports `tapOn: { point: 0x10,0x20 }`, which `inspectMaestroFlow` rejects; the same holds for decimal (`12.5`), negative, and exponent (`1e3`) coordinates. This is a fourth coordinate predicate beside the three in REPLAY-12.
- Fix: use one strict non-negative-integer predicate for coordinates in export (round or reject decimals with an `unsupported` entry) so every exported point re-parses.
- Effort: S
- Model: sonnet
- Verify: export test asserting `inspectMaestroFlow(result.yaml)` does not throw for `click 12.5 40`, or that the export throws `INVALID_ARGS`.

### REPLAY2-7: Percent coordinates are rendered as `50,50%` in progress, trace, and failure labels, and a test pins the wrong text
- Category: broken
- Severity: low     Confidence: high
- Evidence: `packages/maestro/src/internal/progress.ts:125` and `:132-134` append one `%` after `x,y`. Probe: `tapOn: { point: 50%,50% }` gives `{ command: 'tapOn', value: '50,50%' }`. `__tests__/progress.test.ts:20` expects `'90,50% to 10,50%'` for `start: 90%, 50%`. The value flows to `onStep`, the replay trace positionals, and the divergence `action` label (`session-replay-maestro-observer.ts:89-92,110`, `session-replay-maestro-failure.ts:68-70`).
- Fix: format as `${x}%,${y}%` in both helpers (reuse one function); update the test.
- Effort: S
- Model: sonnet
- Verify: `packages/maestro/src/internal/__tests__/progress.test.ts`.

### REPLAY2-8: `invokeOperation` discards every observation its callers build; `observationForTarget` and `defaultArtifacts` are dead
- Category: unneeded
- Severity: low     Confidence: high
- Evidence: `packages/maestro/src/internal/runtime-port-commands.ts:460-464` keeps the `observation` argument only when the effect is `'preserve'`. The four callers that pass one all pass `'invalidate'` (`:234`, `:252`, `:270`, `:322`), and the two `'preserve'` callers pass none (`:387`, `:427`). So `observationForTarget` (`runtime-port-observation.ts:83-97`) has no effect anywhere. `resultWithArtifacts`' `defaultArtifacts` is `[]` at both call sites (`:420`, `:460`).
- Fix: remove the `observation` parameter, `observationForTarget`, and `defaultArtifacts`; simplify `optionalArtifactPaths`.
- Effort: S
- Model: sonnet
- Verify: `tsc`; `packages/maestro/src/internal/__tests__/runtime-port-commands.test.ts`.

### REPLAY2-9: The conformance record says `waitForAnimationToEnd` diffs a hierarchy signature; the code diffs screenshots
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence: `packages/maestro/test/conformance/expected-divergence.ts:142-146` (`animation-wait-mechanism`): "agent-device diffs a typed-hierarchy signature and only falls back to the screenshot metric ... the stabilization mechanism differs by design". `packages/maestro/src/daemon-port/wait-for-animation-to-end.ts:17-36` is screenshot-only ("Matches Maestro's screenshot-based animation wait"), and `daemon-runtime-port.ts:341-352` calls only that. The deviation is consumed only by a substring check in `verify.test.ts:166`, so nothing detects the drift.
- Fix: delete the entry (and any matching sentence in ADR 0015 / the support matrix if it repeats the claim).
- Effort: S
- Model: sonnet
- Verify: `pnpm maestro:conformance` (lead-run).

### REPLAY2-10: `maestro/src/index.test.ts` asserts the absence of two symbols that exist nowhere in the repository
- Category: broken
- Severity: low     Confidence: high
- Evidence: `packages/maestro/src/index.test.ts:15,19` expect the facade not to export `canonicalizeUpstreamMaestroFlow` and `rankMaestroFailureCandidates`; `git grep` finds neither name outside this test. Those two assertions cannot fail. The remaining four are a hand-kept denylist, so a new private symbol exported by mistake also passes.
- Fix: replace the denylist with an exact allowlist of `Object.keys(maestro)` (the test already does this for `package.json` exports at `:31-36`).
- Effort: S
- Model: sonnet
- Verify: `packages/maestro/src/index.test.ts`.

### REPLAY2-11: The "strict wait absent" export test accepts any export failure
- Category: broken
- Severity: low     Confidence: high
- Evidence: `packages/maestro/src/internal/__tests__/export-flow-label-projection.test.ts:56` asserts `thrown.message` matches `/unsupported|strict absence/i`. Every export failure message starts with "Cannot export replay to Maestro YAML: unsupported .ad action" (`export-flow.ts:86-90`), so the assertion holds for any reason, including an unrelated selector-projection failure.
- Fix: assert on `thrown.details.unsupported[0].message` (typed detail already attached at `export-flow.ts:91`) equal to the strict-absence message.
- Effort: S
- Model: sonnet
- Verify: the same test file; mutate `first === 'absent'` branch and confirm the test fails.

### REPLAY2-12: `MaestroFailureReportProjection` carries three fields only a test reads
- Category: unneeded
- Severity: low     Confidence: high
- Evidence: `packages/maestro/src/replay-backend/session-replay-maestro-failure.ts:16-41` builds `command`, `source`, `progress`, and `action`; the only production consumer uses `report.action` (`:57,71`). `git grep buildTypedMaestroFailureReportProjection` finds one other user, the test at `__tests__/session-replay-maestro-failure.test.ts:47`.
- Fix: reduce the function to the capture action (rename to match), drop the unused type fields, and update the test.
- Effort: S
- Model: sonnet
- Verify: `packages/maestro/src/replay-backend/__tests__/session-replay-maestro-failure.test.ts`.

### REPLAY2-13: Backend action failures compute `repairHint` through a call that can only return `'manual'`
- Category: unneeded
- Severity: low     Confidence: high
- Evidence: `packages/replay-port/src/daemon-port/replay-backend-failure.ts:93-97` calls `computeReplayRepairHint({ kind: 'action-failure', targetEvidence: undefined, capture })`. `repair-hint.ts:42` returns `'manual'` whenever `targetEvidence` is undefined, before the capture is read.
- Fix: write `repairHint: 'manual'` and drop the two imports, or pass real evidence if Maestro failures are meant to route to `record-and-heal`.
- Effort: S
- Model: sonnet
- Verify: `tsc`; `packages/daemon/src/sessions/__tests__/replay-maestro/*`.

### REPLAY2-14: `replay-port` adds four more numeric-token rules, and its wait-timeout rule disagrees with the wait parser
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence: `session-replay-heal.ts:24` treats the last `wait` positional as a timeout only when it matches `^\d+$`; the real grammar uses `Number.isFinite(Number(value))` (`command-registry/src/parse-timeout.ts`), so `wait id="x" 1500.5` or `1e3` leaves the timeout inside the selector tokens and yields no suggestion candidate. The same file has `Number.isNaN(Number(first))` for `fill` (`:56`) and `isFiniteNumberString` for `longpress` (`:91-94`); `target-token.ts:36-38` has a fourth (`isNumericToken`). This extends REPLAY-12 into `replay-port`. The file also returns an unused `selectorTimeout` (`:19,33`; no reader) and its header still describes the retired heal actor.
- Fix: derive the wait candidate from `parseWaitPositionals` (`kind === 'selector'`), use the single coordinate predicate proposed in REPLAY-12 for the rest, and delete `selectorTimeout`.
- Effort: S
- Model: sonnet
- Verify: `packages/daemon/src/sessions/__tests__/replay-divergence/session-replay-divergence-suggestions.test.ts` case for `wait id="x" 1e3`.

### REPLAY2-15: Companion state stores a `command` field nothing reads; the contract file comment claims a re-export that is not there
- Category: unneeded
- Severity: low     Confidence: high
- Evidence: `client-companion-tunnel.ts:44,154,419` declare, parse, and write `state.command`; reuse and stop decisions read the live command through `readProcessCommand` (`:228`, `:290`), never the stored one. `client-companion-tunnel-contract.ts:17-19` says the scope type is "Re-exported here for this module's existing consumers", but the line is `import type` only.
- Fix: remove `command` from `CompanionTunnelState` and its reader/writer (this also saves one `ps` spawn per companion start); fix or delete the comment.
- Effort: S
- Model: sonnet
- Verify: `packages/react-native/src/companion/client-metro-companion.test.ts`.

### REPLAY2-16: Exported `inputText` does not escape `${...}`, which Maestro evaluates as JavaScript
- Category: broken
- Severity: low     Confidence: medium
- Evidence: `export-flow.ts:253-259` writes the typed text verbatim. Probe: `type "cost ${amount}"` exports `inputText: cost ${amount}`. Upstream Maestro and this engine (`engine-context.ts:121`) interpolate `${...}` in command strings, so the exported flow types a different string or fails on an undefined variable. The same applies to `fill` text, `find text`, and `wait text` values. Confidence is medium because `.ad` scripts may themselves hold intended `${VAR}` references (see REPLAY-1 for the missing writer escape); the export cannot tell the two apart today.
- Fix: decide the contract with REPLAY-1: once the `.ad` writer escapes literals as `\${`, export `\${` as an escaped Maestro literal and pass real `${VAR}` references through with the `env` block.
- Effort: S
- Model: opus (depends on the REPLAY-1 decision)
- Verify: export test for a literal `\${amount}` round-tripped through `executeMaestroFlow` with a fake port.

### REPLAY2-17: Inspect commands report "The profiler runtime threw inside the app"
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence: `packages/react-native/src/react-devtools/metro-inspector.ts:257-262` uses that message for every `Runtime.evaluate` exception, and the docstring at `:151-155` says "Picks the one React Native runtime to profile". The session is shared by `tree`, `find`, `inspect`, and `errors` (`react-devtools-inspect-command.ts`), and the sibling error text says "React DevTools runtime" (`react-devtools-connection.ts:146-149`).
- Fix: change the message and docstring to "React DevTools runtime".
- Effort: S
- Model: sonnet
- Verify: `packages/react-native/src/react-devtools/metro-inspector.test.ts`.

### REPLAY2-18: `withReplayFailureDiagnostics` is a one-line wrapper around a private function with the same parameters
- Category: unneeded
- Severity: low     Confidence: high
- Evidence: `packages/replay-port/src/daemon-port/session-replay-runtime-failure.ts:22-46` only converts `snapshotDiagnosticSamples` to a summary and calls `withReplayFailureContext` (`:48-116`), which has no other caller and re-declares the full parameter list with an `artifactPaths = []` default the wrapper always fills.
- Fix: merge the two functions.
- Effort: S
- Model: sonnet
- Verify: `tsc`; `packages/replay-port/src/daemon-port/__tests__/session-replay-runtime-failure-response.test.ts`.

### REPLAY2-19: `isStaticAppTarget` is implemented twice with identical bodies
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence: `packages/replay-port/src/daemon-port/replay-script-selection.ts:65-67` and `packages/maestro/src/internal/facade-execution.ts:268-270` both return `Boolean(value?.trim() && !value.includes('$') && !isDeepLinkTarget(value))`. They decide the same thing (the app used to bind a device before a run) for the `.ad` and Maestro paths, so a change to one silently diverges the two backends.
- Fix: export one predicate next to `isDeepLinkTarget` in `@agent-device/contracts/command` and import it in both.
- Effort: S
- Model: sonnet
- Verify: `tsc`; `packages/maestro/src/replay-backend/__tests__/replay-maestro-backend.test.ts`.

### REPLAY2-20: The `evalScript` guard error prints the path and "line" with no separator
- Category: broken
- Severity: low     Confidence: high
- Evidence: `packages/maestro/src/internal/runtime-port-commands.ts:438-441`: `` `... compute engine at ${command.source.path ?? ''}line ${command.source.line}.` `` renders as `at /flows/a.yamlline 3`. The text also contains `line N`, which the regex in REPLAY-13 then treats as an existing location.
- Fix: build the location with the same helper `invalidAt`/`commandFailure` use, or drop it and let the caller add it.
- Effort: S
- Model: sonnet
- Verify: unit case in `runtime-port-commands.test.ts` asserting the message.

### REPLAY2-21: `scrollUntilVisible` can never succeed when the snapshot yields no reference frame
- Category: broken
- Severity: low     Confidence: low
- Evidence: success requires `match.visiblePercentage === 100` (`daemon-runtime-port-observation.ts:203-207`, `daemon-runtime-port.ts:322`). `visiblePercentage` is set only when `getSnapshotReferenceFrame(snapshot)` returns a frame (`daemon-runtime-port-observation.ts:287-292`); that inference can return `undefined` (`packages/capture-kit/src/snapshot/touch-reference-frame.ts:19-20`). In that case a fully visible target keeps scrolling until the timeout and fails with "did not become visible". Not traced: how often frame inference fails on real captures.
- Fix: when no frame is available, fall back to the `matched && visible` verdict, or fail with a typed reason that names the missing viewport.
- Effort: S
- Model: opus (device behaviour)
- Verify: case in `daemon-runtime-port-observation-scroll.test.ts` with a snapshot whose nodes give no frame.
