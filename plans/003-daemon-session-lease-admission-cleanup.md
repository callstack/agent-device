# Plan 003: Bind daemon sessions to active device leases

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report; do not improvise. When done, update the status row for this plan in
> `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 04f53bbc0..HEAD -- src/daemon src/platforms/ios/runner-session.ts src/platforms/android src/contracts.ts src/client-types.ts`
>
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: `plans/001-device-aware-lease-contracts.md`,
  `plans/002-automatic-direct-proxy-lease-on-open.md`
- **Category**: correctness
- **Planned at**: commit `04f53bbc0`, 2026-06-26

## Why this matters

Automatic lease acquisition is only half the fix. The daemon must also bind
session state to the lease that created it, refresh that lease during activity,
reject commands from other clients, and reclaim idle sessions without a proxy
restart. This plan makes the daemon the enforcement point for long-lived proxy
sharing while keeping cloud and limrun provider leases on the same
tenant/run/lease/provider contract.

## Current state

- `src/daemon/request-execution-scope.ts` scopes the request session, resolves
  an effective session, and then calls lease admission.
- `src/daemon/request-admission.ts` currently enforces lease admission only when
  `sessionIsolation === 'tenant'`.
- `src/daemon/session-store.ts` owns persisted daemon sessions.
- `src/daemon/handlers/session-open.ts` creates or updates the session after
  target/app resolution and platform open work.
- `src/daemon/handlers/session-close.ts` tears down resources and deletes the
  session.
- The limrun worktree uses the same `LeaseRegistry`, lease handler, request
  admission, provider release, and device inventory hooks. Treat cloud/limrun
  as in-scope regression paths when provider fields are present.
- `docs/adr/0002-persistent-platform-helper-sessions.md` and
  `docs/adr/0005-ios-runner-interaction-lifecycle.md` keep helper lifecycle in
  the daemon. Do not make CLI clients directly own helpers.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Format | `pnpm format` | exit 0 |
| Focused daemon tests | `pnpm exec vitest run src/daemon/__tests__/request-execution-scope.test.ts src/daemon/__tests__/request-router-open.test.ts src/daemon/__tests__/request-router-lock-policy.test.ts src/daemon/__tests__/session-store.test.ts` | all tests pass |
| Typecheck | `pnpm typecheck` | exit 0, no errors |
| Unit bundle | `pnpm check:unit` | exits 0 in a device-capable environment |

## Scope

**In scope**:
- `src/daemon/types.ts`
- `src/daemon/session-store.ts`
- `src/daemon/request-admission.ts`
- `src/daemon/request-execution-scope.ts`
- `src/daemon/request-router.ts`
- `src/daemon/handlers/session-open.ts`
- `src/daemon/handlers/session-close.ts`
- `src/daemon/handlers/session.ts` only for orchestration around open/close
- `src/daemon/__tests__/request-execution-scope.test.ts`
- `src/daemon/__tests__/request-router-open.test.ts`
- `src/daemon/__tests__/request-router-lock-policy.test.ts`
- `src/daemon/__tests__/session-store.test.ts`
- Limrun/cloud-focused lease tests if `src/cloud/**` or provider lifecycle
  hooks have landed

**Out of scope**:
- Changing platform action implementations.
- Changing the global iOS runner file lease.
- Adding a public lease status command.
- Changing provider runtime allocation internals. Provider regression tests are
  in scope only to prove admission/cleanup did not break them.

## Git workflow

- Branch: `advisor/003-daemon-session-lease-admission-cleanup`
- Commit message: `fix: enforce device leases for daemon sessions`
- Do not push or open a PR unless the operator instructed it.

## Steps

### Step 1: Persist lease ownership on sessions

Extend the daemon session type in `src/daemon/types.ts` with an optional field:

```ts
lease?: {
  leaseId: string;
  tenantId: string;
  runId: string;
  clientId?: string;
  backend?: string;
  leaseProvider?: string;
  deviceKey?: string;
  expiresAt?: number;
};
```

Update `src/daemon/session-store.ts` read/write behavior only as needed. Keep
old sessions without `lease` valid.

Add tests in `src/daemon/__tests__/session-store.test.ts`:

- session lease metadata round-trips through store persistence.
- old session fixture/object without lease metadata still loads.

**Verify**: `pnpm exec vitest run src/daemon/__tests__/session-store.test.ts` -> all tests pass.

### Step 2: Bind `open` sessions to the admitted lease

In `src/daemon/handlers/session-open.ts`, after the lease from Plan 002 has
been allocated/admitted and before persisting the session, write lease metadata
into the session.

Rules:

- If request metadata contains `leaseId`, `tenantId`, `runId`, `leaseProvider`,
  `clientId`, and `deviceKey`, the persisted session must contain the same
  values.
- If request metadata lacks lease fields, preserve existing local behavior.
- If `open` is running in `connect proxy`/tenant isolation and required proxy
  lease fields are missing, throw an actionable `INVALID_ARGS` error before
  platform side effects.
- Cloud/limrun opens may have `leaseProvider` without `deviceKey`; keep that
  valid because those providers allocate runtime devices behind the lease.

Add an open route test proving the stored session contains lease metadata.

**Verify**: `pnpm exec vitest run src/daemon/__tests__/request-router-open.test.ts` -> all tests pass.

### Step 3: Enforce lease admission against the session owner

Update `src/daemon/request-admission.ts` and
`src/daemon/request-execution-scope.ts` so device lease admission works even
when later requests rely on the stored session for ownership context.

Behavior:

- If request metadata has a `leaseId`, use it for admission.
- Else, if the effective session has `session.lease`, use that session lease for
  admission.
- If both exist, they must match on `leaseId`, `tenantId`, `runId`,
  `leaseProvider`, `clientId`, and `deviceKey` when those fields are present.
- If a session has `lease`, commands that are not lease-admission-exempt must
  not run without a matching active lease.
- Lease commands remain admission-exempt.
- Local non-proxy sessions without `session.lease` keep existing behavior.

On successful admission, heartbeat the lease with the requested TTL or the
default from the active lease. Use the proxy TTL of 300,000 ms when the metadata
indicates `leaseProvider: proxy`.

Add tests:

- command with matching session lease succeeds and heartbeats.
- command with wrong `leaseId` is rejected before handler dispatch.
- command with wrong `leaseProvider`, `clientId`, or `deviceKey` is rejected
  before handler dispatch when those fields are present.
- command with no metadata but leased session succeeds by using session lease.
- command for local unleased session still succeeds.
- limrun/cloud provider lease admission still succeeds without `deviceKey` when
  the provider owns runtime allocation behind the lease.

**Verify**: `pnpm exec vitest run src/daemon/__tests__/request-execution-scope.test.ts src/daemon/__tests__/request-router-lock-policy.test.ts` -> all tests pass.

### Step 4: Release lease on close

In `src/daemon/handlers/session-close.ts`, release the session's lease when
closing a leased session.

Rules:

- Release after platform/session cleanup has been attempted.
- Release is idempotent.
- If release says `{ released: false }`, close still succeeds.
- If a different client tries to close a leased session, admission must reject
  before cleanup.

Add tests:

- close releases the session lease.
- wrong client cannot close another client's leased session.

**Verify**: `pnpm exec vitest run src/daemon/__tests__/request-execution-scope.test.ts src/daemon/__tests__/request-router-open.test.ts` -> all tests pass.

### Step 5: Reclaim inactive leased sessions

Add a cleanup path that runs opportunistically before request admission and
lease allocation. Prefer extending `LeaseRegistry.cleanupExpiredLeases()` to
return expired leases, or add a method such as `consumeExpiredLeases()`.

When a lease expires:

- Find sessions with matching `session.lease.leaseId`.
- Delete those sessions from `SessionStore`.
- Tear down associated helper resources only through existing session cleanup
  paths. Do not directly kill runner processes from the lease registry.
- Emit diagnostics with the lease id, session name, device key, and reason
  `LEASE_EXPIRED`.

This cleanup is the five-minute inactivity safety net. It must not require
restarting the proxy.

Add tests:

- advancing fake time past expiry removes the leased session before the next
  command.
- after expiry, another client can open/acquire the same `deviceKey`.
- after expiry, provider release hooks still run for cloud/limrun leases if
  provider lifecycle hooks are present.

**Verify**: `pnpm exec vitest run src/daemon/__tests__/request-execution-scope.test.ts src/daemon/__tests__/session-store.test.ts` -> all tests pass.

## Test plan

- Session persistence coverage in `session-store.test.ts`.
- Admission and heartbeat coverage in `request-execution-scope.test.ts`.
- Open/close behavior coverage in `request-router-open.test.ts`.
- Lock policy regression in `request-router-lock-policy.test.ts`, because
  proxy sessions must remain serialized by the effective scoped session.
- Provider regression coverage when `src/cloud/**` is present: limrun/cloud
  leases still allocate, heartbeat, release, and clean up expired provider
  sessions.

## Done criteria

- [ ] Leased sessions persist lease metadata.
- [ ] Commands against leased sessions are rejected unless the active lease
  matches.
- [ ] Successful commands heartbeat the lease.
- [ ] `close` releases the lease.
- [ ] Expired leases clean up owned sessions without proxy restart.
- [ ] Cloud/limrun provider leases still work when provider hooks are present.
- [ ] Local unleased workflows still work.
- [ ] `pnpm format`, focused tests, and `pnpm typecheck` exit 0.
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report if:

- Session cleanup requires platform-specific runner killing from
  `LeaseRegistry`; that would violate the daemon/helper lifecycle boundary.
- Effective session scoping happens too late to reject wrong-client commands
  before side effects.
- Cloud or limrun leases start failing because proxy-only assumptions leaked
  into provider-backed paths.
- Focused tests fail twice after a reasonable fix attempt.

## Maintenance notes

- The daemon should be the source of truth for active session ownership after
  `open`; CLI state is only a convenience and recovery cache.
- Reviewers should inspect every path that can dispatch platform work and
  confirm leased sessions cannot bypass admission.
- Inactivity cleanup should emit diagnostics, not noisy stderr output.
