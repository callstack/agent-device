# ADR 0010: Error system conventions

- Status: accepted
- Date: 2026-07-03

## Context

The error system is centralized in `src/kernel/errors.ts` (`AppError`, `normalizeError`,
`defaultHintForCode`, `retriableForErrorCode`) but has ~1,200 construction sites across the CLI,
daemon, and platform layers. A July 2026 audit (code sweep + iOS/Android dogfooding) found the
kernel sound while call-site quality drifted: internal validation thrown as bare `Error`
(surfacing as `UNKNOWN` with a misleading hint), semantically wrong codes (`COMMAND_FAILED` for
busy devices, `INVALID_ARGS` for expired server-side resources), missing hints on the most common
agent failures (selector/ref misses), and consumers that drop fields (MCP tool errors carried only
`message`). Nothing documented the conventions, so each new site re-decided them.

## Decision

1. **Every thrown error a user or agent can reach is an `AppError`.** Bare `throw new Error(...)`
   is reserved for provably unreachable invariants. Input validation — including daemon-side
   decoding of command input — throws `AppError('INVALID_ARGS', ...)`. Coercion of unknown caught
   errors uses `asAppError(err, fallbackCode)`, which preserves the cause chain; do not hand-roll
   `err instanceof AppError ? err : new AppError(...)`.
2. **Code selection.** Use the most specific `KnownAppErrorCode`; `COMMAND_FAILED` is for genuine
   runtime failures of a well-formed request, never a catch-all for capability gaps
   (`UNSUPPORTED_OPERATION`), contention (`DEVICE_IN_USE`, the only retriable code), or ambiguity
   (`AMBIGUOUS_MATCH`). New codes are added to the union deliberately; machine-dispatchable
   sub-classification rides in `details.reason` (the lease registry is the model).
3. **Hints answer "what should the agent run next".** A hint is required wherever the per-code
   default from `defaultHintForCode` would mislead; it is omitted where the default suffices —
   mass-adding boilerplate hints is worse than the default. Shared failure modes get shared hint
   constants next to the code that detects them (`selectorFailureHint`, `STALE_REF_HINT` in
   `src/selectors/resolve.ts`; `resolveIosDevicectlHint`; `bootFailureHint`), not copy-pasted
   strings. Re-wraps preserve an existing hint rather than clobbering it.
4. **Wrapping external tool failures.** Prefer `exec.ts` errors as-is. A hand-rolled wrap of an
   `allowFailure` result must carry `{ stdout, stderr, exitCode, processExitError: true }` so
   `normalizeError` can surface the first meaningful stderr line instead of "tool exited with
   code N".
5. **The wire error contract** is `code`, `message`, `hint`, `details` (redacted), `diagnosticId`,
   `logPath`, plus optional typed signals `retriable` / `supportedOn` — the fields are absent
   unless confidently known. Every consumer surface (CLI human, CLI `--json`, SDK, MCP, events
   timeline) must carry code + message + hint at minimum; rehydration helpers
   (`throwDaemonError`, `toDaemonHttpRpcError`) copy all fields, and `NormalizedError` hoists the
   typed signals so `--json` consumers see them.
6. **Observability.** Failed requests always flush diagnostics: `diagnosticId` + ndjson `logPath`
   accompany every error (daemon-side under the session state dir, client-side under
   `~/.agent-device/logs`). Messages must not embed raw stderr dumps or secrets — structured
   context belongs in `details`, which is redacted at normalize/write time.

## Consequences

- Agents can branch on `code`, retry on `retriable`, and follow `hint` without parsing prose;
  wording can improve without breaking consumers (except strings pinned by help-text guarantees —
  update those tests in lockstep).
- The known-code union stays small and meaningful; the widened `(string & {})` type still lets
  runner/daemon codes pass through, so SDK consumers keep a `default` branch.
- New call sites have a documented bar: right code, contextual message naming the target, hint
  only when the default misleads, cause preserved.
