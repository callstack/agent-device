# ADR 0010: Error system conventions

- Status: accepted
- Date: 2026-07-03

> **Amended by [ADR 0019](0019-request-bound-platform-runtime.md).** Existing normalization and cause-preservation rules remain accepted.
> If an operation and binding/resource cleanup both fail, the operation remains primary.
> Cleanup becomes structured secondary diagnostic evidence.
> A cleanup-only failure returns normally as a failure.

## Rules at a glance

- Every reachable thrown error is an `AppError`. Reserve bare `Error` for provably unreachable invariants.
- For input validation, use `INVALID_ARGS`. For unknown caught errors, use `asAppError(err, fallbackCode)`.
- Use the most specific `KnownAppErrorCode`. Put machine-dispatchable subclasses in `details.reason`.
- Supply a hint only when the default would mislead. Preserve existing hints and causes through wrappers.
- Every consumer must carry at least code, message, and hint. Rehydration helpers copy all error fields.
- Failed requests always flush diagnostics. Messages must not contain raw stderr dumps or secrets.

## Context

`packages/kernel/src/errors.ts` centralizes `AppError`, `normalizeError`, `defaultHintForCode`, and `retriableForErrorCode`.
However, approximately 1,200 sites construct errors across CLI, daemon, and platform layers.
A July 2026 audit combined code examination with iOS/Android use.
It found a sound kernel but inconsistent call sites:

- Internal validation threw bare `Error`, which appeared as `UNKNOWN` with a misleading hint.
- Some codes had incorrect semantics, such as `COMMAND_FAILED` for busy devices or `INVALID_ARGS` for expired server-side resources.
- Common selector/ref failures lacked hints.
- Consumers lost fields, such as MCP tool errors that carried only `message`.

Without documented conventions, each new site selected its own behavior.

## Decision

1. **Every thrown error a user or agent can reach is an `AppError`.**
   Reserve bare `throw new Error(...)` for provably unreachable invariants.
   Input validation, including daemon-side command input decode, throws `AppError('INVALID_ARGS', ...)`.
   For unknown caught errors, use `asAppError(err, fallbackCode)` to preserve the cause chain.
   Do not construct a replacement through `err instanceof AppError ? err : new AppError(...)`.
2. **Code selection.** Use the most specific `KnownAppErrorCode`.
   `COMMAND_FAILED` means a genuine runtime failure of a well-formed request.
   Never use it as a general code for:
   - Capability gaps: `UNSUPPORTED_OPERATION`.
   - Contention: `DEVICE_IN_USE`.
   - Ambiguity: `AMBIGUOUS_MATCH`.
   Only `DEVICE_IN_USE` is retriable by default.
   The cross-worktree device-claim path overrides it with `retriable: false`.
   Add new codes to the union deliberately.
   Put machine-dispatchable subclasses in `details.reason`, as the lease registry does.
3. **Hints answer "what should the agent run next".**
   If the per-code default from `defaultHintForCode` would mislead, a hint is required.
   If the default suffices, omit the hint.
   Repeated boilerplate hints are worse than the default.
   Shared failure modes use shared hint constants beside their detection code, instead of copied strings:
   - `selectorFailureHint` and `STALE_REF_HINT` in `packages/selectors/src/internal/resolve.ts`.
   - `resolveIosDevicectlHint`.
   - `bootFailureHint`.
   Wrappers preserve an existing hint instead of replacing it.
4. **Wrapping external tool failures.** Prefer unchanged errors from `exec.ts`.
   A manual wrapper of an `allowFailure` result must carry `{ stdout, stderr, exitCode, processExitError: true }`.
   Thus, `normalizeError` can expose the first meaningful stderr line instead of "tool exited with code N".
5. **The wire error contract** contains:
   - `code`.
   - `message`.
   - `hint`.
   - Redacted `details`.
   - `diagnosticId`.
   - `logPath`.
   - Optional typed signals `retriable` / `supportedOn`.
   Unless confidently known, typed signals are absent.
   Every consumer surface must carry at least code, message, and hint:
   - CLI human output.
   - CLI `--json`.
   - SDK.
   - MCP.
   - Events timeline.
   Rehydration helpers `throwDaemonError` and `toDaemonHttpRpcError` copy all fields.
   `NormalizedError` exposes typed signals at its top level for `--json` consumers.
6. **Observability.** Failed requests always flush diagnostics.
   Every error carries `diagnosticId` and ndjson `logPath`.
   Daemon diagnostics reside under the session state dir.
   Client diagnostics reside under `~/.agent-device/logs`.
   Messages must not contain raw stderr dumps or secrets.
   Structured context belongs in `details`, which is redacted at normalization/write time.

## Consequences

- Agents can select behavior by `code`, retry by `retriable`, and follow `hint` without prose parsing.
  Wording can improve without breaking consumers, except for strings fixed by help-text guarantees.
  When those strings change, update their tests together.
- The known-code union remains small and meaningful.
  The wider `(string & {})` type still passes runner/daemon codes through, so SDK consumers retain a `default` branch.
- New call sites have documented requirements:
  - Correct code.
  - Contextual message that names the target.
  - Hint only when the default misleads.
  - Preserved cause.
