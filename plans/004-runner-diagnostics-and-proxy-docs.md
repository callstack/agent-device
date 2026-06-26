# Plan 004: Align runner diagnostics and proxy docs

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report; do not improvise. When done, update the status row for this plan in
> `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 04f53bbc0..HEAD -- src/platforms/ios/runner-lease.ts src/platforms/ios/runner-session.ts src/platforms/ios/__tests__/runner-session.test.ts src/utils/cli-help.ts src/utils/__tests__/args.test.ts README.md website docs`
>
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: `plans/001-device-aware-lease-contracts.md`,
  `plans/002-automatic-direct-proxy-lease-on-open.md`,
  `plans/003-daemon-session-lease-admission-cleanup.md`
- **Category**: dx | docs
- **Planned at**: commit `04f53bbc0`, 2026-06-26

## Why this matters

The iOS runner file lease should remain the low-level guard that prevents two
daemons from controlling one XCTest runner, but it should no longer be the
first user-visible ownership model for local/proxy iOS contention. After Plans
001 through 003, `connect proxy` users should see device lease errors before
runner ownership errors. Limrun/cloud iOS devices route through provider
interactors and are not expected to hit the local iOS runner file lease.

## Current state

- `src/platforms/ios/runner-lease.ts` stores global runner ownership under
  `~/.agent-device/ios-runner/leases` and reports owner daemon details.
- `src/platforms/ios/runner-session.ts` starts/reuses long-lived XCTest runner
  sessions per device.
- `src/utils/cli-help.ts` remote/direct proxy guidance currently tells users
  direct proxy mode should not use connect, tenant, run, or lease flags.
- Cloud docs in `/Users/thymikee/Developer/agent-device-cloud/docs/connecting-agent-device.md`
  already define the recommended flow as `connect` -> normal commands ->
  `disconnect`. The limrun worktree adds `connect limrun` with generated remote
  config and `leaseProvider: limrun`.
- `src/commands/management/prepare.ts` help already distinguishes runner
  preparation from recovery for "runner already owned by another daemon".
- `docs/adr/0005-ios-runner-interaction-lifecycle.md` requires readiness probes
  and stale runner invalidation. Do not remove that behavior.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Format | `pnpm format` | exit 0 |
| Runner tests | `pnpm exec vitest run src/platforms/ios/__tests__/runner-session.test.ts` | all tests pass |
| Help tests | `pnpm exec vitest run src/utils/__tests__/args.test.ts` | all tests pass |
| Typecheck | `pnpm typecheck` | exit 0, no errors |
| Swift runner build | `pnpm build:xcuitest` | exit 0 if Swift runner files changed |

## Scope

**In scope**:
- `src/platforms/ios/runner-lease.ts`
- `src/platforms/ios/runner-session.ts`
- `src/platforms/ios/__tests__/runner-session.test.ts`
- `src/utils/cli-help.ts`
- `src/utils/__tests__/args.test.ts`
- `README.md`
- `website/docs/**` only if direct proxy docs already exist there

**Out of scope**:
- Replacing the iOS runner file lease.
- Changing XCUITest runner Swift code unless diagnostics require it.
- Adding a new public status command. If needed, create a separate plan.
- Reworking Android platform behavior.

## Git workflow

- Branch: `advisor/004-runner-diagnostics-and-proxy-docs`
- Commit message: `docs: clarify direct proxy device leases`
- Do not push or open a PR unless the operator instructed it.

## Steps

### Step 1: Attach logical lease context to runner diagnostics

After Plan 003, runner startup/reuse should be reachable only after device
lease admission. Thread non-secret logical lease context from daemon session or
request metadata into iOS runner session startup diagnostics:

```ts
{
  leaseId?: string;
  clientId?: string;
  tenantId?: string;
  runId?: string;
  leaseProvider?: string;
  deviceKey?: string;
}
```

Use existing diagnostics helpers. Do not write this context into the global
runner lease file unless the file already has a versioned schema and safe
backward compatibility. If you do persist it, make every field optional and keep
old lease files readable.

**Verify**: `pnpm exec vitest run src/platforms/ios/__tests__/runner-session.test.ts` -> all tests pass.

### Step 2: Improve runner busy errors without weakening ownership checks

In `src/platforms/ios/runner-lease.ts`, keep the existing stale-owner and
same-state reclaim behavior. Update user-facing busy errors so, when logical
lease context is available, the message/hint says:

- The device is busy because another active device lease owns it, or
- The runner is owned by another daemon/process after lease admission, which is
  now a backend inconsistency and should include state dir/PID diagnostics.

Do not suggest restarting the long-lived proxy as the first recovery step.
Suggested hint:

"Retry after the owning session closes or after the five-minute inactivity
lease expires. If this persists after expiry, inspect the runner owner details
and clean the stale daemon state on the machine with simulator access."

Add tests covering:

- logical lease context appears in diagnostics.
- old runner busy errors still include state-dir/PID details.
- stale same-state reclaim still works.

**Verify**: `pnpm exec vitest run src/platforms/ios/__tests__/runner-session.test.ts` -> all tests pass.

### Step 3: Update direct proxy help

Update `src/utils/cli-help.ts` remote/direct proxy section:

- Remove guidance that direct proxy users should not use `connect` or leases.
- Explain that agents should run `agent-device connect proxy --daemon-base-url
  <proxy-agent-device-url>` before using a shared proxy.
- Explain that `connect` establishes the connection profile and client identity;
  the proxy device lease is acquired lazily on `open`.
- State the inactivity timeout: five minutes with no commands refreshes.
- State that `disconnect` releases the connection lease and local state. State
  that `close` releases the session/device lease once Plan 003 behavior exists.
- State that multiple agents can share one proxy if they use normal
  `connect proxy`/`open`/command/`disconnect` flow; the daemon isolates
  sessions by client.
- State that a busy device error means another agent owns the device until it
  closes or the lease expires.
- Present cloud, remote config, proxy, and limrun as connection providers under
  the same lifecycle. Do not expose provider internals in normal command
  examples.
- Keep the copy compact; this repo treats CLI help as the agent-facing source
  of truth.

Update `src/utils/__tests__/args.test.ts` with assertions for the important
copy, especially "connect proxy", "automatic on open", "five minutes", and
"disconnect releases".

**Verify**: `pnpm exec vitest run src/utils/__tests__/args.test.ts` -> all tests pass.

### Step 4: Update README and website docs only where direct proxy is documented

Search:

`rg -n "agent-device proxy|direct proxy|remote proxy|lease" README.md website docs`

For each existing direct proxy section, align it with the CLI help:

- one long-lived proxy process on the device host;
- agents run `connect proxy` to create a connection profile;
- agents acquire device leases automatically on `open`;
- leases refresh on activity and expire after five minutes;
- `disconnect` releases the connection lease and local state;
- do not restart the proxy to recover normal contention.

Do not introduce a new long tutorial if no docs section exists; CLI help is the
canonical agent-facing source.

**Verify**: `rg -n "Do not use connect|Do not use .*lease|restart.*proxy" src/utils/cli-help.ts README.md website docs` -> no stale direct-proxy guidance remains, except unrelated contexts that clearly do not refer to direct proxy recovery.

## Test plan

- `runner-session.test.ts` for runner diagnostic behavior.
- `args.test.ts` for CLI help copy.
- `pnpm typecheck` for threading logical lease context through typed runner
  session code.
- `pnpm build:xcuitest` only if Swift runner files changed.

## Done criteria

- [ ] Runner diagnostics can include logical lease context without exposing
  secrets.
- [ ] Runner busy errors still preserve state-dir/PID details.
- [ ] Direct proxy help says to use `connect proxy` and that leases are
  automatic on `open`.
- [ ] Help/docs mention five-minute inactivity expiry and `disconnect` release.
- [ ] Stale guidance telling users not to use `connect` or leases with direct
  proxy is gone.
- [ ] `pnpm format`, focused tests, and `pnpm typecheck` exit 0.
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report if:

- Improving diagnostics requires changing Swift runner behavior.
- The global runner lease file cannot accept optional fields without breaking
  existing installs. In that case, keep logical lease context diagnostics-only.
- Help updates reveal a missing public command that is necessary for recovery;
  create a follow-up plan instead of adding the command here.
- Focused tests fail twice after a reasonable fix attempt.

## Maintenance notes

- Runner/process lease errors should become rare in direct proxy mode. If users
  still see them during normal contention, admission is being bypassed.
- Limrun/cloud iOS sessions should not depend on local runner file-lease
  diagnostics; keep those docs provider-neutral.
- Reviewer focus: make sure docs describe the implemented behavior, not the
  desired future behavior.
