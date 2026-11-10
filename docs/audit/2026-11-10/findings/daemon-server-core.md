# DSRV audit: daemon server / core

## Coverage

Slice: `packages/daemon/src/{server,core,__tests__,index.ts}`, `packages/daemon/{test,docs,package.json}` (~350 files, ~72k lines, of which ~21k are production source and the rest tests/fixtures).

- Read fully (production): all of `server/http/*` except `daemon-runtime-deps.ts` (types only, skimmed); `server/request-router.ts`, `request-execution-scope.ts`, `request-execution-locks.ts`, `upload-http.ts`, `upload.ts`, `resumable-upload*.ts`, `artifact-download.ts`, `artifact-archive.ts`, `downloadable-artifact-http.ts`, `request-diagnostics-http.ts`, `host-lease-http.ts`, `human-control-http.ts`, `http-errors.ts`, `http-request-target.ts`, `remote-host-input-policy.ts`, `request-finalization.ts`, `request-lease-work.ts`, `platform-request-scope.ts`, `provider-lease-expiry.ts`, `session-idle-expiry.ts`; `core/session-store.ts`, `daemon-command-registry.ts`, `daemon-request.ts`, `daemon-policy.ts`, `tenant-owned-entry.ts`, `session-tenant-scope.ts`, `request-dispatch-ledger.ts`, `request-ended-leases.ts`, `config.ts`, `context.ts`, `execution-plan.ts`, `generic-leaf-execution.ts`, `interactor-resolution.ts`, `provider-device-admission.ts`, `session-idle-tombstone.ts`, `recording-values.ts`, `snapshot-interactor-capture.ts`; `index.ts`, `package.json`, `docs/remote-device-lease-contracts.md` (first half).
- Skimmed / heuristic only: all `*.test.ts` in the slice (scanned for skip/only/todo, zero-assert tests, unused support fixtures: none found), `src/__tests__/support/*` (usage-grepped only), `test/nightly/*` (wiring checked only), `docs/replay-repair-transaction.md` (not read).
- Not reached: `core/` interaction, gesture, recording, snapshot, ref-frame, script-writer / publication-state, composite-resource-admission, runtime-admission, session-runtime-admission, selector-recording (~7k production lines); `server/request-lock-policy.ts`, `response-views.ts`, `request-binding.ts`, `application-lifecycle-recovery.ts`, `replay-device-selection.ts`, `request-platform-provider-context.ts`, `request-save-script-policy.ts`.
- Rough coverage: ~85% of `server/` production code, ~20% of `core/` production code, ~50% of slice production code, ~15% of slice lines including tests. Focus was concurrency, shutdown, auth/token, resource cleanup as instructed. Nothing was executed; every finding is from reading code and grep.

## Findings

### DSRV-1: Daemon-level diagnostics emitted outside any diagnostics scope are silently dropped
- Category: broken
- Severity: medium     Confidence: high
- Evidence: `packages/host-kit/src/internal/diagnostics.ts:178-180` — `emitDiagnostic` returns immediately when no scope is active. The runtime itself documents this (`packages/daemon/src/server/http/daemon-runtime.ts:745-748`: "a SIGTERM shutdown has no request, and therefore no diagnostics scope, so `emitDiagnostic` would drop every detach reason") and wraps some steps in `withDaemonDiagnosticsScope`, but these calls run unwrapped:
  - `daemon-runtime.ts:776-788` `daemon_shutdown_provider_release_drain` (commented as "the shutdown's one summary" of released/pending/refused leases and orphaned device keys) — in `closeSteps`, not inside a scope.
  - `daemon-runtime.ts:767-771` `daemon_shutdown_android_snapshot_helper_cleanup_failed`.
  - `daemon-runtime.ts:610-616` `daemon_lifecycle_startup_recovery_failed` (startup, no scope).
  - `server/http/daemon-shutdown-claims.ts:84-93` `daemon_shutdown_device_claim_release_failed`, called from `teardownDaemonSessions()` at `daemon-runtime.ts:756` (unwrapped).
  - `server/provider-lease-expiry.ts:253-261, 504-521` (`provider_lease_expiry_retry_scheduled`, `provider_lease_journal_write_failed`, `provider_lease_expiry_record_write_failed`, level `error`) when reached from the 1 s lease-expiry sweep (`daemon-runtime.ts:303-306`) or from `recoverInherited` at startup (`daemon-runtime.ts:590`); only the outcome mapping at `daemon-runtime.ts:278-296` is routed through `emitDaemonDiagnostic`. Confidence for this sub-item is medium: the timer may inherit a finished request's scope instead, in which case the event lands in a dead scope's buffer rather than the log.
  - No test references any of the first four phases (`grep` across repo finds only the emit sites).
- Fix: wrap the whole of `closeSteps` (or at least lines 756-789) in one `withDaemonDiagnosticsScope({ logPath }, ...)`; replace the two bare startup/shutdown `emitDiagnostic` calls with `emitDaemonDiagnostic`; pass a `withinDiagnosticsScope` seam to `createExpiredProviderLeaseReleaser` (same shape `createLeaseSessionEnd` and `createSessionIdleExpiry` already take) and run timer/startup-driven work through it. Files: `server/http/daemon-runtime.ts`, `server/provider-lease-expiry.ts`.
- Effort: M
- Model: opus (shutdown ordering, ALS scope semantics)
- Verify: extend `server/http/daemon-runtime-lifecycle-shutdown.test.ts` to assert `daemon_shutdown_provider_release_drain` appears in `daemon.log` after a signal-style `close()`; extend `server/__tests__/provider-lease-expiry.test.ts` to assert a persistence failure from a timer-driven retry is recorded.

### DSRV-2: Session-teardown timeout timer is never cancelled: false "timed out" line and event loop held after close
- Category: broken
- Severity: medium     Confidence: high
- Evidence: `packages/daemon/src/server/http/server-shutdown.ts:358-364` — `Promise.race([teardown, sleep(timeoutMs).then(() => { stderr.write('Daemon session teardown timed out ...'); return false; })])`. `sleep` (`packages/host-kit/src/internal/retry.ts:256-281`) is a ref'd, uncancelled `setTimeout`. When teardown wins the race the timer still fires 5 s to 46 s later (`sessions/session-teardown-budget.ts:4-13`) and writes the "timed out" line for a session that tore down cleanly. For the detached daemon this appears whenever the rest of close outlasts the budget (owner shutdown 5 s + plugin close 5 s + lease drain 2 s budgets follow it); for an embedded runtime (`src/host.ts:43`) the host process cannot exit naturally for up to 46 s per session after `runtime.close()` resolves. Same uncancelled-`sleep` pattern, lower impact: `server/provider-lease-expiry.ts:391` (2 s) and `daemon-runtime.ts:843-846` (1 s). The sibling `settleWithinBudget` (`server-shutdown.ts:201-219`) and `budgetElapsedAfter` (`daemon-session-idle-expiry.ts:317-327`) already do this correctly.
- Fix: reuse `settleWithinBudget` (or pass an `AbortSignal` to `sleep`) in `teardownDaemonSessionForShutdown`, write the timeout line only when the deadline branch actually wins; same for the releaser drain and PNG-worker race. Files: `server/http/server-shutdown.ts`, `server/provider-lease-expiry.ts`, `server/http/daemon-runtime.ts`.
- Effort: S
- Model: sonnet
- Verify: new case in `server/http/daemon-runtime-close.test.ts` using fake timers: fast teardown, advance past the budget, assert stderr has no "teardown timed out" and no pending timers remain.

### DSRV-3: Socket transport buffers unbounded input before authentication
- Category: broken
- Severity: medium     Confidence: high
- Evidence: `packages/daemon/src/server/http/transport.ts:38,63-65` accumulates `buffer` through `consumeTextLines` (`packages/host-kit/src/internal/transport.ts:5-19`), which has no size cap; the token is only checked later in the router (`server/request-router.ts:261`). Any local process that connects to the loopback socket port and never sends a newline grows daemon memory without limit. The HTTP transport caps the same payload at 1 MiB (`server/http/http-server.ts:71,234`), so the two transports disagree.
- Fix: cap `buffer.length` in `createSocketServer` at the same limit as `/rpc`, answer one `INVALID_ARGS` error line and destroy the socket when exceeded. File: `server/http/transport.ts` (share the constant with `http-server.ts`).
- Effort: S
- Model: sonnet
- Verify: new test beside `server/http/*transport*` tests: write >1 MiB without `\n`, assert the socket is closed with an error line and the handler is never invoked.

### DSRV-4: `parseIntegerEnv('')` returns 0, so an empty lease env var yields a 1 ms lease TTL
- Category: broken
- Severity: medium     Confidence: high
- Evidence: `packages/daemon/src/server/http/server-lifecycle.ts:7-12` — `Number('')` is `0`, which passes `Number.isInteger`. `daemon-runtime.ts:274-277` feeds it to `LeaseRegistry`; `resources/lease-registry-scope.ts:106-111` then computes `Math.max(1, 0)`, so `AGENT_DEVICE_LEASE_TTL_MS=` (set-but-empty, common in CI/env files) makes every default lease expire after 1 ms, and `AGENT_DEVICE_LEASE_MIN_TTL_MS=` drops the minimum to 1 ms. It also accepts `'0x10'`, `'1e3'`, `' 5 '`. The sibling parser `server/session-idle-expiry.ts:47-53` trims and treats empty as unset, so the two daemon env-integer parsers disagree. The only test (`server/http/server-lifecycle.test.ts:63-65`) covers `'10'`, `'1.5'`, `undefined`.
- Fix: return `undefined` for empty/whitespace and require `/^-?\d+$/`. File: `server/http/server-lifecycle.ts` (+ test).
- Effort: S
- Model: sonnet
- Verify: add `assert.equal(parseIntegerEnv(''), undefined)` and `'0x10'`/`'1e3'` cases to `server-lifecycle.test.ts`.

### DSRV-5: Upload routes inherit Node's default 300 s `requestTimeout` while accepting 2 GiB bodies
- Category: broken
- Severity: medium     Confidence: medium
- Evidence: `packages/daemon/src/server/http/http-server.ts:221` creates the server with `http.createServer(onRequest)` and nothing in `server/` sets `requestTimeout`/`headersTimeout` (grep: no hits). Node's default `server.requestTimeout` is 300 000 ms for receiving the whole request. `/upload` and `PUT /upload/direct/<id>` accept up to `MAX_ARTIFACT_COMPRESSED_BYTES = 2 GiB` (`packages/host-kit/src/internal/artifact-limits.ts:1`) in one streamed request and deliberately implement an *idle* timeout of 60 s instead of a total one (`server/artifact-download.ts:13,66-82`). A transfer slower than ~7 MB/s (tunnel/proxy use, which the `proxy` help text advertises) is cut by Node at 5 minutes regardless of progress. Not reproduced by execution; based on Node's documented default.
- Fix: set `server.requestTimeout = 0` (or a per-route budget) on the daemon HTTP server and rely on the existing idle timer; add an idle bound to the resumable receive path, which today has none. Files: `server/http/http-server.ts`, `server/resumable-upload-transfer.ts`.
- Effort: S
- Model: opus (transport behavior; needs a real slow-upload check, and the proxy package has the same default)
- Verify: test that constructs the server and asserts `server.requestTimeout === 0`; manual slow upload (`curl --limit-rate`) of >5 min through `agent-device proxy`.

### DSRV-6: Legacy `/upload` ignores the client's `x-artifact-hash`; only the resumable path verifies integrity
- Category: inconsistent
- Severity: medium     Confidence: high
- Evidence: the client sends `x-artifact-hash` / `x-artifact-hash-algorithm` on the legacy route (`packages/remote/src/upload-client.ts:212-215`) and the proxy forwards them (`packages/proxy/src/daemon-proxy.ts:112-113`), but `packages/daemon/src/server/upload.ts:13-55` reads only `x-artifact-type`, `x-artifact-filename`, `content-length`. The resumable path checks sha256 before materializing (`server/resumable-upload.ts:138-145`). The legacy route is the fallback after a failed direct upload (`upload-client.ts:88-103`), i.e. exactly when the transport is already flaky, and it installs whatever arrived.
- Fix: hash while streaming in `receiveUpload` and reject on mismatch when the header is present (reuse `computeUploadHash` or a hashing transform). Files: `server/upload.ts`, `server/artifact-download.ts`.
- Effort: S
- Model: sonnet
- Verify: new case in `server/__tests__/upload.test.ts`: wrong `x-artifact-hash` yields `INVALID_ARGS` and the temp dir is removed.

### DSRV-7: Request-diagnostics route leaks a file descriptor when the client disconnects mid-stream
- Category: broken
- Severity: low     Confidence: medium
- Evidence: `packages/daemon/src/server/request-diagnostics-http.ts:155-162` uses `stream.pipe(res)` with only an `error` handler. `pipe` does not destroy the source when the destination closes, so an aborted download leaves the `fs.ReadStream` open. The sibling artifact route uses `pipeline` + `finished` + explicit `stream.destroy()` (`server/downloadable-artifact-http.ts:106-149`). It also sends `content-length` from a `stat` taken before the read, on a record file the request flush can still append to.
- Fix: replace with `await pipeline(stream, res)` inside the existing try/catch (routing failure through `failStreamedHttpResponse`). File: `server/request-diagnostics-http.ts`.
- Effort: S
- Model: sonnet
- Verify: test in `server/__tests__/` for the diagnostics route: destroy the client socket mid-body, assert the read stream reports `destroyed === true`.

### DSRV-8: `/rpc` has its own body reader that counts UTF-16 units and answers oversize with a connection reset
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence: `packages/daemon/src/server/http/http-server.ts:225-251` — `MAX_HTTP_RPC_BODY_BYTES` is compared with `body.length` after `setEncoding('utf8')` (characters, not bytes), and on overflow calls `req.destroy(new Error('request too large'))`, which tears down the socket so the `-32700 Parse error` the `error` listener then writes never reaches the client. The test pins the reset rather than an answer: `server/http/http-server-provider-scenarios.test.ts:356` accepts `/aborted|reset|socket hang up|request too large/`. Every sibling route uses the shared `readNodeHttpRequestBody` (`packages/host-kit/src/internal/transport.ts:57-73`: byte count, typed `INVALID_ARGS` → 400 JSON) — `upload-http.ts:230-236`, `human-control-http.ts:147-161`.
- Fix: read `/rpc` through `readNodeHttpRequestBody` and answer a JSON-RPC `-32600`/400 "request too large" before closing; tighten the test to one expected outcome. Files: `server/http/http-server.ts`, that test.
- Effort: S
- Model: sonnet
- Verify: `http-server-provider-scenarios.test.ts` oversize case asserts HTTP 400 with a JSON-RPC error body.

### DSRV-9: Unauthenticated socket requests count as daemon activity and re-arm the idle reap
- Category: broken
- Severity: low     Confidence: medium
- Evidence: `packages/daemon/src/server/http/daemon-runtime.ts:493-508` runs `idleReap.cancel()`, adds to `inFlightRequests`, then `idleReap.noteActivity()` and `sessionIdleExpiry.noteSessionsChanged()` for every request the lifecycle admission passes to the handler; the token is only compared inside the router (`server/request-router.ts:261`). The socket transport performs no token check of its own (`server/http/transport.ts:73-96`), unlike HTTP (`http-server.ts:574`). A local process that periodically sends any JSON line with a wrong token keeps a detached daemon from ever idle-reaping, and an in-flight bogus request makes `quiesce` answer busy (`sessions/server/daemon-idle-reap.ts:253-260`).
- Fix: compare the token in `createSocketServer` (or in the runtime's `handleRequest` wrapper) before touching idle-reap/in-flight state, returning the same `UNAUTHORIZED` response. Files: `server/http/transport.ts` or `server/http/daemon-runtime.ts`.
- Effort: S
- Model: opus (auth ordering on a public transport)
- Verify: case in `server/http/daemon-runtime-idle-reap.test.ts`: wrong-token socket requests do not postpone the reap.

### DSRV-10: Streaming `/rpc` contract comment contradicts the code: headers are not sent before the handler starts
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence: `packages/daemon/src/server/http/http-server.ts:653-659` states a streaming request "gets its headers before the handler starts", but lines 676-681 only set `statusCode` and a header; nothing calls `flushHeaders()`, so headers go out with the first progress write. Consequence visible in the same file: a handler that throws before any progress event reaches `sendRpcRequestFailure` with `res.headersSent === false` (lines 744-748) and answers `application/json` with an error status, not the NDJSON envelope the comment says is "the only way left to report it".
- Fix: either call `res.flushHeaders()` after setting the NDJSON content type (making the comment true and the failure framing uniform) or correct the comment. File: `server/http/http-server.ts`.
- Effort: S
- Model: opus (wire-visible behavior; client in `packages/remote`/`daemon-client` must be checked for both framings)
- Verify: test in `server/__tests__/http-server-rpc-validation.test.ts`: streaming request whose handler throws immediately; assert content type and framing match the chosen contract.

### DSRV-11: Token extraction is implemented twice and the gate order differs between `/rpc` and the auxiliary routes
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence: `server/http/http-authorization.ts:147-158` (`resolveToken`: params > `x-agent-device-token` > bearer) and `server/human-control-http.ts:130-144` (`assertHostAdminAuthorized`: header || bearer, re-parsing the same two headers). Order: `/rpc` runs the operator auth hook, then tenant trust, then the token (`http-server.ts:555-577`, documented there as "the security contract"), while `authorizeAuxiliaryHttpRequest` compares the token first, then the hook, then tenant trust (`http-authorization.ts:175-212`). The same unattested-tenant caller gets a token error on `/artifacts` and a tenant-trust error on `/rpc`, and on `/rpc` an unauthenticated caller still executes the operator hook.
- Fix: one header-token reader used by both; pick one gate order and express it in one function both paths call. Files: `server/http/http-authorization.ts`, `server/human-control-http.ts`, `server/http/http-server.ts`.
- Effort: M
- Model: opus (auth contract)
- Verify: `server/__tests__/http-server-tenant-trust.test.ts` with a table over routes asserting the same rejection for the same credentials.

### DSRV-12: Five different request-target parsers; query strings and encoding are handled differently per route
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence: exact string match — `/health`, `/rpc` (`http-server.ts:113,197`), `/upload`, `/upload/preflight`, `/upload/finalize` (`upload-http.ts:82-90`); regex strip — `/upload/direct/<id>` (`upload-http.ts:86`); `indexOf('?')` — `/artifacts` (`downloadable-artifact-http.ts:190-194`); `split('?')` — diagnostics (`request-diagnostics-http.ts:84`); `URL.parse` — `/admin/leases` (`host-lease-http.ts:103`); `new URL` in try/catch — human control (`human-control-http.ts:117-123`). So `/rpc?x=1` and `/upload?x=1` are 404 while `/artifacts?x=1` and `/upload/direct/id?x=1` work; artifact and diagnostics ids are percent-decoded via the shared `decodeUriSegment` (`http-request-target.ts`, whose header says a route decoding "its own way would disagree with its siblings"), but lease ids and hold ids are used still-encoded.
- Fix: one `readRequestPathname` in `server/http-request-target.ts` used by every route, plus `decodeUriSegment` for lease/hold ids. Files: the six route modules above.
- Effort: S
- Model: sonnet
- Verify: table test over all routes with `?q=1` appended and with a percent-encoded id.

### DSRV-13: `platform` and root-name inference in `artifact-archive.ts` are unreachable from production
- Category: unneeded
- Severity: low     Confidence: high
- Evidence: `server/artifact-archive.ts:47-98` — `inferArchiveRootName` runs only when `expectedRootName` is undefined. Both production callers always pass it (`server/upload.ts:43-48`, `server/resumable-upload.ts:242-247`, both from a sanitized non-empty filename). Only `server/__tests__/artifact-archive.test.ts:33` calls without it. `upload.ts:46` additionally hardcodes `platform: 'ios'` while `resumable-upload.ts:245` derives it, which only goes unnoticed because the parameter is dead.
- Fix: make `expectedRootName` required, delete `platform` and `inferArchiveRootName`, and drop the tests that exercise only the inference. Files: `server/artifact-archive.ts`, `server/upload.ts`, `server/resumable-upload.ts`, `server/__tests__/artifact-archive.test.ts`.
- Effort: S
- Model: sonnet
- Verify: `pnpm check:affected --run` (typecheck + the archive and upload tests).

### DSRV-14: Hyphenated JSON-RPC method aliases have no producer in the repo
- Category: unneeded
- Severity: low     Confidence: medium
- Evidence: `server/http/http-rpc-methods.ts:18-37` accepts both `agent_device.*` and `agent-device.*` for every method. The only producer (`packages/contracts/src/lease-scope.ts:582,609-613`) emits the underscore form; the hyphen form appears only in the daemon/proxy allowlists and tests (`grep` for `agent-device.command` outside tests: `packages/proxy/src/daemon-proxy.ts:262` only), and no doc mentions it. AGENTS.md: compat paths only on explicit request. Medium confidence because an out-of-repo client could depend on it.
- Fix: confirm with the owner, then remove the hyphen aliases here and in `packages/proxy/src/daemon-proxy.ts`, and switch the tests to the underscore form.
- Effort: S
- Model: sonnet
- Verify: `http-server-rpc-validation.test.ts` asserts `agent-device.command` answers `-32601`.

### DSRV-15: Preflight for an existing resumable upload returns the ticket without refreshing its expiry
- Category: broken
- Severity: low     Confidence: medium
- Evidence: `server/resumable-upload.ts:80-103` — `beginResumableUpload` reuses `existing` by key but only `createResumableUploadEntry` (line 181) and a successful append (line 118) call `refreshResumableUploadTimer`. A retry-preflight (`packages/remote/src/upload-client.ts:184`) issued late in the 5-minute window hands back a ticket that can expire seconds later, mid-chunk (`expireEntry`, lines 196-210, destroys the active receive).
- Fix: call `refreshResumableUploadTimer(existing)` on reuse. File: `server/resumable-upload.ts`.
- Effort: S
- Model: sonnet
- Verify: fake-timer test in `server/__tests__/` for resumable upload: preflight at T+4:59, advance 2 s, chunk still accepted.

### DSRV-16: Remote host-input restriction runs twice per HTTP request
- Category: inefficient
- Severity: low     Confidence: high
- Evidence: `server/http/http-authorization.ts:70-74` (`restrictRemoteHttpRequest` → `restrictRemoteHostInputs`) at admission, then again unconditionally at `server/request-execution-scope.ts:239`; for `batch` each pass re-runs `validateAndNormalizeBatchSteps` and recurses over every step (`server/remote-host-input-policy.ts:130-146`), and each nested step passes through the scope again.
- Fix: keep the scope-level call (it also covers nested steps) and have the HTTP layer only stamp `publicNetworkOnly` and strip `developerDir`/`providerCredentialFingerprint`. Files: `server/http/http-authorization.ts`.
- Effort: S
- Model: opus (security boundary; must prove nothing between admission and scope reads the unrestricted request — `daemon-idle-reap.ts:236` reads only the marker)
- Verify: `server/http/http-server-remote-host-arguments.test.ts` and `http-server-remote-output.test.ts` stay green.

### DSRV-17: Comments that record history or name callers, against the AGENTS.md comment rule, some stale
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence: `core/session-store.ts:505-507` lists the callers of `resolveDaemonStateDir` (stale: also called from `server/request-execution-scope.ts:335,439,665`); `core/daemon-command-registry.ts:30-34` narrates a deleted hand-authored literal and issue #906; `core/generic-leaf-execution.ts:19-22` narrates "R58 retired the legacy alternative"; `server/request-finalization.ts:41-50` narrates a past bug ("this used to copy ... but NOT ..."). AGENTS.md: comments only for public APIs, tool directives, or constraints code cannot show.
- Fix: delete or reduce each to the standing constraint. Files as listed.
- Effort: S
- Model: sonnet
- Verify: `pnpm format` and lint only.
