# ADR 0010: Error system conventions

- Status: accepted
- Date: 2026-07-03

> **Amended by [ADR 0019](0019-request-bound-platform-runtime.md).** Existing normalization and cause-preservation rules remain accepted.
> If an operation and binding/resource cleanup both fail, the operation remains primary.
> In that case, the cleanup failure is structured secondary diagnostic evidence.
> If only cleanup fails, the cleanup failure surfaces normally.

## Rules at a glance

- Every thrown error that a user or agent can reach is an `AppError`. Reserve bare `Error` for provably unreachable invariants.
- For input validation, throw `AppError('INVALID_ARGS', ...)`. To coerce an unknown caught error, use `asAppError(err, fallbackCode)`.
- Use the most specific `KnownAppErrorCode`. Put machine-dispatchable sub-classification in `details.reason`.
- If the per-code default hint would mislead, supply a hint. If the default suffices, omit the hint.
- When you wrap an error, preserve an existing hint and the cause chain.
- Every consumer surface must carry at least code, message, and hint. Rehydration helpers copy all fields.
- Failed requests always flush diagnostics. Messages must not embed raw stderr dumps or secrets.

## Context

The error system is centralized in `packages/kernel/src/errors.ts` (`AppError`, `normalizeError`, `defaultHintForCode`, `retriableForErrorCode`).
However, approximately 1,200 construction sites exist across the CLI, daemon, and platform layers.
A July 2026 audit combined a code sweep with iOS/Android dogfooding.
It found the kernel sound, but call-site quality had drifted:

- Internal validation threw bare `Error`, which surfaced as `UNKNOWN` with a misleading hint.
- Some codes were semantically wrong, such as `COMMAND_FAILED` for busy devices and `INVALID_ARGS` for expired server-side resources.
- The most common agent failures, selector/ref misses, had no hints.
- Some consumers dropped fields; for example, MCP tool errors carried only `message`.

Nothing documented the conventions, so each new site decided them again.

## Decision

1. **Every thrown error a user or agent can reach is an `AppError`.**
   Bare `throw new Error(...)` is reserved for provably unreachable invariants.
   Input validation, including daemon-side decoding of command input, throws `AppError('INVALID_ARGS', ...)`.
   To coerce an unknown caught error, use `asAppError(err, fallbackCode)`, which preserves the cause chain.
   Do not hand-roll `err instanceof AppError ? err : new AppError(...)`.
2. **Code selection.** Use the most specific `KnownAppErrorCode`.
   `COMMAND_FAILED` is for genuine runtime failures of a well-formed request.
   Never use `COMMAND_FAILED` as a catch-all for these cases:
   - Capability gaps. Use `UNSUPPORTED_OPERATION`.
   - Contention. Use `DEVICE_IN_USE`.
   - Ambiguity. Use `AMBIGUOUS_MATCH`.
   `DEVICE_IN_USE` is the only code that is retriable by default.
   The cross-worktree device-claim path overrides that default to `retriable: false`.
   Add new codes to the union deliberately.
   Machine-dispatchable sub-classification goes in `details.reason`; the lease registry is the model.
3. **Hints answer "what should the agent run next".**
   If the per-code default from `defaultHintForCode` would mislead, a hint is required.
   If the default suffices, omit the hint.
   Boilerplate hints added in bulk are worse than the default.
   Shared failure modes get shared hint constants next to the code that detects them, not copy-pasted strings:
   - `selectorFailureHint` and `STALE_REF_HINT` in `packages/selectors/src/internal/resolve.ts`.
   - `resolveIosDevicectlHint`.
   - `bootFailureHint`.
   A re-wrap preserves an existing hint instead of overwriting it.
4. **Wrapping external tool failures.** Prefer `exec.ts` errors as they are.
   A hand-rolled wrap of an `allowFailure` result must carry `{ stdout, stderr, exitCode, processExitError: true }`.
   Thus, `normalizeError` can surface the first meaningful stderr line instead of "tool exited with code N".
5. **The wire error contract** contains:
   - `code`.
   - `message`.
   - `hint`.
   - `details` (redacted).
   - `diagnosticId`.
   - `logPath`.
   - Optional typed signals `retriable` / `supportedOn`.
   The typed signals are absent unless they are confidently known.
   Every consumer surface must carry at least code, message, and hint:
   - CLI human output.
   - CLI `--json`.
   - SDK.
   - MCP.
   - Events timeline.
   Rehydration helpers (`throwDaemonError`, `toDaemonHttpRpcError`) copy all fields.
   `NormalizedError` hoists the typed signals, so `--json` consumers see them.
6. **Observability.** Failed requests always flush diagnostics.
   A `diagnosticId` and an ndjson `logPath` accompany every error.
   Daemon-side diagnostics are under the session state dir.
   Client-side diagnostics are under `~/.agent-device/logs`.
   Messages must not embed raw stderr dumps or secrets.
   Structured context belongs in `details`, which is redacted at normalize/write time.

## Consequences

- Agents can branch on `code`, retry on `retriable`, and follow `hint` without prose parsing.
  Wording can improve without breaking consumers, except for strings that help-text guarantees pin.
  If you change one of those strings, update its tests in the same change.
- The known-code union stays small and meaningful.
  The widened `(string & {})` type still lets runner/daemon codes pass through, so SDK consumers keep a `default` branch.
- New call sites have a documented bar:
  - The correct code.
  - A contextual message that names the target.
  - A hint only when the default misleads.
  - A preserved cause.
