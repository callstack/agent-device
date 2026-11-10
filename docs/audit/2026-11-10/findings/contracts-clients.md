# Audit report: SLICE CONTR (contracts, daemon-contracts, daemon-client, client, remote, proxy, session-journal, contracts/fixtures)

## Coverage

Slice is ~75k lines (36k contracts, 8.7k daemon-contracts, 16.7k daemon-client, 5.2k client, 5.3k remote, 1.8k proxy, 3.1k session-journal, 14.8k fixtures JSON).

- Read fully (production source): all of `packages/proxy/src` (non-test) + README; `packages/remote/src` (all non-test files except `remote-config-schema.ts`); `packages/daemon-client/src/{daemon-client-transport,daemon-client-progress,daemon-client-rpc,daemon-client-timeout,daemon-client-lease-beat,index}.ts`; `packages/client/src/lease-client.ts`; `packages/session-journal/src/{session-event-log,session-event-log-lines,keyboard-actions}.ts`; `packages/daemon-contracts/src/{daemon-process,daemon-policy-file,session-artifact-paths}.ts`; `packages/contracts/src/daemon-http.ts`.
- Read partially: `daemon-client-startup.ts` (first 330 lines), `client/src/index.ts` (first 200 lines), `daemon-client-metadata.ts`, `contracts/src/{lease-scope,backend,snapshot-types,client-target,interaction,keyboard,client-system}.ts` (targeted regions), three test files.
- Mechanical whole-slice sweeps (scripted, whole-repo grep): every exported symbol in the slice vs. non-test users repo-wide; every `package.json` subpath export (167) vs. importers; every `contracts/fixtures/*.json` vs. loaders (TS, Swift, Kotlin, scripts, docs); duplicate exported type names across slice + kernel + command-surface; `.skip/.only/.todo`, TODO/FIXME; tests with no assertions; error-reason literals vs. producers.
- Not reached (no line-by-line read): most of `packages/contracts/src` runtime-plan/gesture/snapshot modules (~30k lines), `daemon-contracts` device-claim* and daemon-registration* (~4k lines), `daemon-client-{lifecycle,ensure,liveness-probe,launch-spec}.ts`, `client-normalizers.ts`, `session-event-{action,request,log-window}.ts`, and nearly all test files. Roughly 25% of production lines read closely, 100% covered by the mechanical sweeps.
- Clean results worth recording: all 167 subpath exports have production importers; all 34 fixtures are loaded by at least one test/consumer; no `.skip/.only/.todo` or TODO/FIXME in the slice; dead exports are essentially clean (one exception, CONTR-11).

## Findings

### CONTR-1: Upload client follows redirects to any origin and re-sends the daemon bearer token
- Category: broken (security)
- Severity: high     Confidence: high
- Evidence: `packages/remote/src/upload-stream.ts:101-119` — on 301/302/303/307/308 with `Location`, `streamFileToHttpRequestAttempt({...options, url: redirectedUrl})` re-uses `options.headers` unchanged. For the legacy path those headers are built at `packages/remote/src/upload-client.ts:213-221` and include `authorization: Bearer <token>` and `x-agent-device-token` (`buildDaemonHttpAuthHeaders`). No same-origin check and no https->http downgrade check exist (the only origin check in the package is for the lease header, `upload-client.ts:365-368`). A redirecting or compromised endpoint (or an on-path attacker for an `http://` base URL) receives the daemon token plus the whole artifact. `fetch` strips `Authorization` on cross-origin redirects; this hand-rolled follower does not. 303 also keeps the method and body.
- Fix: in `upload-stream.ts`, on redirect compare `redirectedUrl.origin` with the original origin; on a cross-origin hop drop `authorization`, `x-agent-device-token`, and lease headers (or refuse outright), and refuse https->http. Add a test beside `packages/remote/src/__tests__/upload-client.test.ts`.
- Effort: S
- Model: sonnet
- Verify: new test in `packages/remote/src/__tests__/upload-client.test.ts` with two loopback servers (A redirects to B) asserting B sees no auth headers; `pnpm vitest run packages/remote`.

### CONTR-2: Proxy's default 5-minute upstream timeout is shorter than the client envelopes it carries, and expiry cancels the daemon work
- Category: inconsistent / broken
- Severity: medium     Confidence: high
- Evidence: `packages/proxy/src/daemon-proxy.ts:105` (`DEFAULT_UPSTREAM_TIMEOUT_MS = 5 * 60 * 1000`) applied to every forwarded request at `:348-350`; `src/cli/commands/proxy.ts:38-42` creates the server without `upstreamTimeoutMs`. Client envelopes in `packages/command-registry/src/timeout-policy.ts`: `INSTALL_REQUEST_TIMEOUT_MS = 480_000` (:11), `INSTALL_SOURCE_REQUEST_TIMEOUT_MS = 600_000` (:14), `LEASE_ALLOCATE_REQUEST_TIMEOUT_MS = 330_000` (:36-37, provider budget is exactly 300 000). Through `agent-device proxy` an install that needs more than 300 s is aborted by the proxy; the abort propagates upstream and (per the comment at `daemon-proxy.ts:344-347`) cancels in-flight runner work, and the client then sees the degraded error of CONTR-3 instead of the daemon's own timeout result.
- Fix: derive the proxy `/rpc` timeout from the registry (max envelope + margin) or make `/rpc` unbounded and rely on the client's envelope and `request.signal`; keep the fixed cap only for uploads/artifacts if wanted. Touch `packages/proxy/src/daemon-proxy.ts`, README option table, `src/cli/commands/proxy.ts`.
- Effort: S-M
- Model: opus
- Verify: unit test in `packages/proxy/src/daemon-proxy.test.ts` asserting the default `/rpc` timeout >= the largest `envelopeMs` in `commandDescriptors`.

### CONTR-3: Proxy answers `/rpc` failures with a REST-shaped body the client cannot read; message and code are lost
- Category: inconsistent
- Severity: medium     Confidence: high
- Evidence: `packages/proxy/src/daemon-proxy.ts:762-768` (`proxyErrorResponse`) returns `{ ok:false, error:"<string>", code }` for every thrown error regardless of route (upstream unreachable, upstream timeout, body too large `:609`, invalid tenant `:230`). Client side, `packages/daemon-client/src/daemon-client-rpc.ts:31-34,104-123` treats `parsed.error` as `{ message, data }`: for a string, `error.data` and `error.message` are `undefined`, so the user gets `COMMAND_FAILED: "Daemon RPC request failed"` with no code, hint, or cause. Same root: a `/rpc` body that is not a JSON object with a valid header token reaches `rewriteRpcParams` (`:635-643`), where `JSON.parse` throws (or `null.params` throws) and yields HTTP 500, whereas the daemon itself answers -32700/-32600 with 400 (`packages/daemon/src/server/http/http-server.ts:353-365`). The client never checks the HTTP status code either (`daemon-client-transport.ts:840-884`).
- Fix: in the proxy, when `route === '/rpc'` emit JSON-RPC envelopes (`{jsonrpc, id, error:{code, message, data: normalizeError(e)}}`) from `proxyErrorResponse`, and validate the envelope before `rewriteRpcParams` (reuse the daemon's -32700/-32600 mapping). Files: `packages/proxy/src/daemon-proxy.ts`, tests.
- Effort: S
- Model: sonnet
- Verify: `packages/proxy/src/daemon-proxy.test.ts` cases for upstream-fetch rejection and non-JSON body on `/rpc`; a `daemon-client-rpc.test.ts` case that feeds the proxy body through `handleDaemonHttpResponseBody` and asserts the message survives.

### CONTR-4: A remote daemon's response chooses the local path the client writes artifacts to
- Category: broken (security)
- Severity: medium     Confidence: medium
- Evidence: `packages/remote/src/daemon-artifacts.ts:457-472` — `resolveMaterializedArtifactPath` prefers `artifact.localPath` from the response over the client's own `req.meta.clientArtifactPaths`, and falls back to `path.resolve(cwd, artifact.fileName)` with no separator/`..` check; the bytes are then written by `artifact-download.ts:54-57` (file) or extracted under that root (directory). `nextData[artifact.field]` (`:446`) is likewise keyed by a response string. A hostile or compromised remote daemon / gateway (hosted provider, shared proxy) can overwrite any file the user can write (e.g. shell rc, `authorized_keys`). The daemon legitimately echoes `localPath` (`packages/daemon/src/server/request-finalization.ts:159,178`, `record-runtime-response.ts:111-136`) because `record stop` arrives in a later request than `record start`, so the fix needs a client-side record, not just deletion.
- Fix: accept a response `localPath` only when it equals a path this client registered (`req.meta.clientArtifactPaths[field]`, or a client-persisted record for `record`/`trace` start); otherwise materialize under cwd using `path.basename(fileName)`. Files: `packages/remote/src/daemon-artifacts.ts`, the record/trace client state.
- Effort: M
- Model: opus
- Verify: new test in `packages/remote/src/__tests__/artifact-download.test.ts` / `daemon-artifacts-capture.test.ts` where the response names `/tmp/outside/x` and `fileName: '../../x'`; assert the write stays in the requested location.

### CONTR-5: Remote diagnostics path escapes `remote-diagnostics/` for session `..` (guard documented in the same file is not applied)
- Category: broken (security, low impact)
- Severity: low     Confidence: high
- Evidence: `packages/daemon-contracts/src/session-artifact-paths.ts:51-59` builds `path.join(stateDir, 'remote-diagnostics', safeSessionName(ref.session))`; `safeSessionName` keeps `.` and `..` (`packages/host-kit/src/session-paths.ts:3-5`), and `resolveSessionDir` in the same file (`:61-75`) states exactly that and guards with `isSafeSessionSegment`. `ref.session` comes from the remote daemon's error (`packages/kernel/src/errors.ts:548-554`, only non-empty-string checked) via `packages/remote/src/remote-request-diagnostics.ts:95`. A response naming session `..` makes the client write up to 8 MiB to `<stateDir>/requests/<id>.ndjson`.
- Fix: make `resolveRemoteRequestDiagnosticsPath` go through `resolveSessionDir(path.join(stateDir,'remote-diagnostics'), ref.session)` (throws -> already mapped to `logPathUnavailable` by the caller's catch at `remote-request-diagnostics.ts:104`).
- Effort: S
- Model: sonnet
- Verify: case in `packages/daemon-contracts/src/session-artifact-paths.test.ts` and `packages/remote/src/__tests__/remote-request-diagnostics.test.ts` with `session: '..'`.

### CONTR-6: Two same-named, differently-shaped `BackendSnapshotResult` types exported from `@agent-device/contracts`
- Category: inconsistent
- Severity: medium     Confidence: high
- Evidence: `packages/contracts/src/backend.ts:41-46` (`snapshot: SnapshotState` required, no `nodes/truncated/backend/viewport/freshness/quality`) vs `packages/contracts/src/snapshot-types.ts:26-50` (`snapshot?`, plus `nodes?`, `truncated?`, `backend?`, `viewport?`, `androidSnapshot?`, `freshness?`, `quality?` ...). The first is exported from `@agent-device/contracts/backend` (used by `packages/daemon/src/sessions/snapshot-command-runtime.ts:11`, `command-runtime/.../snapshot.ts:22`); the second from the `capture` facade (`packages/contracts/src/facades/capture.ts:59-65`) and used by `interactor-types.ts:15,272`. `BackendSnapshotOptions` is also declared twice with identical bodies (`backend.ts:48-52`, `snapshot-types.ts:52-56`).
- Fix: rename the interactor-level one (e.g. `InteractorSnapshotResult` / `PlatformSnapshotCapture`) or derive one from the other; delete the duplicate `BackendSnapshotOptions` in `snapshot-types.ts` and re-export from `backend.ts`. Update the facade and `test/wire-compat` digests if the name is digested.
- Effort: S-M
- Model: sonnet
- Verify: `pnpm tsc -b packages/contracts packages/daemon packages/command-runtime`; `git grep -n "type BackendSnapshotResult"` returns one hit.

### CONTR-7: Client artifact download treats 3xx as success and can sit 90 s on a truncated error body
- Category: broken
- Severity: low     Confidence: high
- Evidence: `packages/remote/src/artifact-download.ts:99` only treats `>= 400` as failure, so a 301/302/304 body (HTML or empty) is written to the destination as the artifact; the sibling fetcher uses `statusCode !== 200` (`packages/remote/src/remote-request-diagnostics.ts:185-190`). In the error branch (`:100-116`) only `res.on('end')` settles; a connection dropped mid-body leaves the promise pending until the 90 s timer because `request.on('error')` does not fire after the response started.
- Fix: require `statusCode === 200`; add `res.on('error'|'aborted')` in the error branch. One file.
- Effort: S
- Model: sonnet
- Verify: cases in `packages/remote/src/__tests__/artifact-download.test.ts` (302 reply; 500 reply with socket destroyed mid-body).

### CONTR-8: Keyboard action vocabulary is spelled in six places with three different member sets; its "owner" lives in session-journal
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence: `packages/session-journal/src/keyboard-actions.ts:1` (`status,get,dismiss,enter,return`); `packages/contracts/src/backend.ts:92` (same five, re-spelled); `packages/contracts/src/client-system.ts:117` (four, no `get`); `packages/contracts/src/keyboard.ts:16` (three); `packages/command-surface/src/system/index.ts:92,255,811` (four / three / four); `packages/daemon/src/execution/keyboard-runtime.ts:34` (three). `isKeyboardAction` is imported from `@agent-device/session-journal/keyboard-actions` by `packages/command-runtime/src/commands/system/runtime/system.ts:14` and `packages/daemon/src/execution/keyboard-runtime.ts:23` — an execution-layer vocabulary owned by the journal package.
- Fix: move the const tuple + guard into `@agent-device/contracts` (next to `keyboard.ts`), derive the wire/result/client subsets from it with `Extract`/`Exclude`, and drop the `./keyboard-actions` export from `packages/session-journal/package.json`.
- Effort: S-M
- Model: sonnet
- Verify: `git grep -n "'status' | 'get' | 'dismiss'"` returns no hand-written unions; `pnpm tsc -b`; layering check.

### CONTR-9: `InteractionTarget` / `PointTarget` / `RefTarget` / `SelectorTarget` / `ElementTarget` each exist twice in contracts with incompatible shapes
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence: `packages/contracts/src/client-target.ts:3-29` (no discriminant, `label?`, `never`-exclusion fields) vs `packages/contracts/src/interaction.ts:11-30` (`kind: 'selector'|'ref'|'point'`, `fallbackLabel?`). Both are exported under the same five names from the same package, so an auto-import picks either; the ref label is `label` in one and `fallbackLabel` in the other.
- Fix: prefix the client-facing set (`ClientPointTarget` ...) or the runtime set (`ResolvedInput*`), and keep one conversion function as the only bridge.
- Effort: M (rename fan-out)
- Model: sonnet
- Verify: `pnpm tsc -b`; duplicate-name scan (`git grep -nE "^export type (Point|Ref|Selector|Element|Interaction)Target\b" packages/contracts/src`) returns five hits.

### CONTR-10: Lease error reasons the client dispatches on have no producer or no shared constant
- Category: unneeded / inconsistent
- Severity: low     Confidence: medium
- Evidence: `packages/contracts/src/lease-scope.ts:497-501` lists `LEASE_NOT_FOUND`, `LEASE_EXPIRED`, `LEASE_REVOKED` as "inactive lease" error reasons. Repo-wide (non-test) `LEASE_REVOKED` appears only there and in `packages/daemon-client/docs/remote-device-leases.md:48`; `LEASE_EXPIRED` is produced only as a session-end reason (`packages/daemon/src/sessions/lease-lifecycle.ts:23,77`, `daemon-runtime.ts:297`), never as `details.reason` of an `UNAUTHORIZED` error (the registry throws `LEASE_NOT_FOUND`, `lease-registry.ts:665`). Separately `LEASE_SCOPE_REQUIRED` / `LEASE_SCOPE_MISMATCH` are bare literals on both sides (`packages/daemon-client/src/daemon-client-lease-beat.ts:45-48` vs `packages/daemon/src/resources/lease-registry-scope.ts:252,313`), and `remote_instance_mismatch` is a bare literal in three packages (`daemon-client-transport.ts:527,846`, `proxy/src/daemon-proxy.ts:717`, `daemon/src/server/http/http-instance-precondition.ts`) while `daemon-http.ts` owns the rest of that protocol.
- Fix: delete the two producerless reasons (and the doc line) unless a plugin contract needs them; export the scope reasons and the instance-mismatch reason as constants from `contracts/lease-scope` / `contracts/daemon-http` and use them on both sides.
- Effort: S
- Model: sonnet
- Verify: `git grep -n "LEASE_REVOKED"` empty; `pnpm vitest run packages/contracts packages/daemon-client`.

### CONTR-11: `buildLeaseDiagnosticsContext` and `LeaseDiagnosticsContext` are production exports used only by one daemon test
- Category: unneeded
- Severity: low     Confidence: high
- Evidence: `packages/contracts/src/lease-scope.ts:41,421-438` ("@internal ... exposed for unit tests"); the only other reference repo-wide is `packages/daemon/src/core/__tests__/lease-context.test.ts:9,96-113`. Production unused-exports are only `warn` in `fallow-production-exports.json`, so the gate does not catch it.
- Fix: delete the function, the type, and the test case.
- Effort: S
- Model: sonnet
- Verify: `git grep -n buildLeaseDiagnosticsContext` empty; `pnpm tsc -b packages/contracts packages/daemon`.

### CONTR-12: Upload has a fixed 5-minute whole-transfer cap independent of size; fallback restarts from byte 0; retry swallows aborts
- Category: broken / inefficient
- Severity: low     Confidence: medium
- Evidence: `packages/remote/src/upload-stream.ts:13,155-164` — one `setTimeout(UPLOAD_TIMEOUT_MS)` per attempt for the whole body (not an idle timeout), so any artifact that cannot transfer in 300 s always fails (a 1 GB app at 20 Mbit/s needs ~400 s). After a direct-upload timeout, `upload-client.ts:118-153,185-192` re-preflights once and then falls to `uploadLegacyArtifact`, which re-sends the whole file under the same cap. `retryDirectUpload`'s bare `catch { return undefined }` (`:188-190`) also swallows a caller abort and emits a misleading `fallback` progress event before the legacy path rejects. A legacy-stage resume would send both `transfer-encoding: chunked` (`upload-client.ts:219`) and `content-length` (`upload-stream.ts:226-229`).
- Fix: make the timer an inactivity timer reset from the progress transform; in `retryDirectUpload` rethrow when `options.signal?.aborted`; strip `transfer-encoding` when a resume sets `content-length`.
- Effort: S-M
- Model: sonnet
- Verify: `packages/remote/src/__tests__/upload-client.test.ts` with fake timers (slow-but-progressing upload passes) and `upload-client-cancellation.test.ts` (no `fallback` event after abort).

### CONTR-13: Proxy trusts a client-supplied `x-forwarded-proto` verbatim when building the upload ticket URL
- Category: broken (hardening)
- Severity: low     Confidence: high
- Evidence: `packages/proxy/src/daemon-proxy.ts:447-450` interpolates the header into `new URL(\`${forwardedProto}://${requestUrl.host}\`)`. A value such as `https://other.example/#` changes the ticket host (the ticket carries the caller's credential headers, `:413-416`); a value with a space makes `new URL` throw and the preflight returns 500. The sender is the client itself or any intermediary that does not strip the header.
- Fix: accept only `http` or `https`, otherwise ignore the header. One line + test.
- Effort: S
- Model: sonnet
- Verify: `packages/proxy/src/daemon-proxy.test.ts` case with `x-forwarded-proto: "https://evil/#"` asserting the ticket origin equals the request origin.

### CONTR-14: Connection-state validator still admits the superseded `daemon.authToken` field
- Category: unneeded (superseded compat path)
- Severity: low     Confidence: high
- Evidence: `packages/remote/src/remote-connection-state.ts:626` accepts `record.authToken` although `RemoteConnectionState['daemon']` (`:39-43`) has no such field and the token is "never persisted" (`:300-303`, ADR 0007); tests assert it is never written (`__tests__/remote-connection-state.test.ts:115,151`). A pre-ADR file holding a token therefore validates and is kept on disk indefinitely. `buildRemoteConnectionDaemonState`'s parameter type also still picks `daemonAuthToken` (`:254-258`) without reading it.
- Fix: drop the `authToken` clause (a legacy file then fails validation and is removed by `removeInvalidRemoteConnectionState`), and drop `daemonAuthToken` from the `Pick`.
- Effort: S
- Model: sonnet
- Verify: test that a state file containing `daemon.authToken` is deleted on read; `pnpm vitest run packages/remote`.

### CONTR-15: Small duplicated owners inside `packages/remote`
- Category: inconsistent / unneeded
- Severity: low     Confidence: high
- Evidence: (a) `packages/remote/src/remote-config.ts:1` is a one-line re-export of `resolveRemoteConfigProfile` from `remote-config-core.ts`, and both are separate package exports; importers are split (`src/cli/remote-config-flags.ts:6` uses core, `src/cli/commands/connection.ts:4` etc. use the alias), so `vi.mock` of one path does not cover the other (`src/__tests__/cli-leased-session.test.ts:19`). (b) `daemon-artifacts.ts:508-511` `buildDaemonArtifactUrl` and `upload-client.ts:61` re-implement `buildDaemonHttpUrl` (`contracts/src/daemon-http.ts:22-25`). (c) `daemon-artifacts.ts:513-515` `isRemoteDaemon` duplicates `daemon-client-metadata.ts`'s. (d) `daemon-artifacts.ts:20-24` hand-copies `DEFAULT_TEST_ARTIFACTS_ROOT` from `packages/replay-test/src/internal/session-test-artifacts.ts:14` with no test pinning the two equal.
- Fix: delete `remote-config.ts` + its export and point the five importers at `remote-config-core`; use `buildDaemonHttpUrl`; add an equality assertion for the artifacts-root literal (or move the literal to kernel).
- Effort: S
- Model: sonnet
- Verify: `pnpm tsc -b`; `git grep -n "remote/remote-config'"` empty.

### CONTR-16: Stale, orphaned, and history-narrating comments (AGENTS.md comment rule)
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence: `packages/daemon-client/src/daemon-client-transport.ts:51-67` — a JSDoc block attached to nothing (followed immediately by another JSDoc). `packages/daemon-client/src/daemon-client-lease-beat.ts:19-26` and `:64-70` — the same paragraph twice. `packages/daemon-client/src/index.ts:47-50` — "Remote artifact upload still reads the process (`packages/remote`, tracked by #3751)" although `uploadArtifact`/`prepareRemoteRequestArtifacts` now take `host.env`/`host.cwd`; the only process read left is `process.stderr` in `upload-progress.ts:65-67`. History narration rather than constraints: `daemon-client-timeout.ts:10-19` ("The client used to recover host-scoped..."), `contracts/src/keyboard.ts:10-12` ("the previous hand-written mirror is dropped"), `daemon-client/src/index.ts:292-304` ("BLOCKER 2, third follow-up"). `daemon-client-transport.ts:659-663` is an unreachable branch (the abort listener at `:686-696` already destroyed the socket before `connect` can fire).
- Fix: delete/trim the listed comments and the dead branch.
- Effort: S
- Model: sonnet
- Verify: `pnpm format && pnpm vitest run packages/daemon-client`.

### CONTR-17: Tests that cannot fail at runtime
- Category: broken (tests)
- Severity: low     Confidence: high
- Evidence: `packages/contracts/src/network-runtime.test.ts:48-57` and `packages/contracts/src/ios-snapshot.test.ts:116-130` — the `test()` bodies are only `void` statements; their own comments say the test exists "because Vitest needs the file to contain one". The real checks are `@ts-expect-error`/`satisfies` lines enforced by `tsc -b` (tests are in `packages/contracts/tsconfig.json` `include`). They count as passing tests while asserting nothing. `packages/daemon-client/src/__tests__/daemon-client-ensure-scripted-daemon.test.ts` exercises only the test double `startScriptedDaemon`, no production code.
- Fix: move the compile-time proofs to non-test `*.type-proof.ts` files (still under `tsc -b`) and delete the empty tests; fold the scripted-daemon check into the fixture's first real consumer or delete it.
- Effort: S
- Model: sonnet
- Verify: `pnpm tsc -b packages/contracts`; test count drops by three with no coverage change.

### CONTR-18: `waitForDaemonExit` spawns a synchronous `ps` every 100 ms while a daemon is still alive
- Category: inefficient
- Severity: low     Confidence: medium
- Evidence: `packages/daemon-contracts/src/daemon-process.ts:78-90` — each poll calls `readHostProcessIdentityObservations([pid])`, a `spawnSync` of the host process tool (`packages/host-kit/src/internal/host-process.ts:178`), whenever `isProcessAlive` is true. During a graceful stop this is ~10 blocking process spawns per second for the whole term timeout, on the client's event loop (also reached from the timeout-recovery path `daemon-client-timeout.ts:127-136`).
- Fix: poll `isProcessAlive` (signal 0) at 100 ms and sample `ps` at a coarser cadence (e.g. every 5th poll and once at the deadline) for the zombie/pid-reuse proof.
- Effort: S
- Model: sonnet
- Verify: `packages/daemon-contracts/src/daemon-process.test.ts` with a counted spawn stub; `src/__tests__/daemon-exit-wait.test.ts` still green.

### CONTR-19: Socket transport accepts any JSON line as the response; cleanup failure masks the request error
- Category: broken
- Severity: low     Confidence: medium
- Evidence: `packages/daemon-client/src/daemon-client-progress.ts:74-77` — in `socket-legacy` mode a line that is neither a progress nor a response envelope is passed to `onResponse(message as DaemonResponse)` unvalidated (`null`, a number, or a foreign service's JSON resolves the request and crashes later at `response.ok`), while the HTTP path rejects the same shape as `daemon_response_invalid` (`daemon-client-rpc.ts:35-43`). `packages/daemon-client/src/index.ts:320-328` — if `cleanupDaemonAfterRequest` throws after `send()` failed, the cleanup error replaces `requestError`.
- Fix: require `typeof message === 'object' && typeof message.ok === 'boolean'` before resolving in legacy mode, else `createInvalidDaemonResponseError`; wrap cleanup in try/catch when `requestFailed` and rethrow the original.
- Effort: S
- Model: sonnet
- Verify: cases in `packages/daemon-client/src/__tests__/daemon-client-progress.test.ts` (line `null`) and `index.test.ts` (failing send + throwing cleanup).
