# Plan 001: Add device-aware lease contracts

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report; do not improvise. When done, update the status row for this plan in
> `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 04f53bbc0..HEAD -- CONTEXT.md docs/adr src/contracts.ts src/client-types.ts src/remote-config-schema.ts src/remote-connection-state.ts src/daemon/lease-context.ts src/daemon/lease-registry.ts src/daemon/handlers/lease.ts src/daemon/http-server.ts src/daemon/__tests__/lease-registry.test.ts src/daemon/__tests__/request-handler-catalog.test.ts`
>
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: HIGH
- **Depends on**: none
- **Category**: correctness | architecture
- **Planned at**: commit `04f53bbc0`, 2026-06-26

## Why this matters

The current lease model can say "tenant/run has an iOS simulator allocation",
but it cannot say "client A owns device C25D... through provider proxy for the
next five minutes". Direct proxy needs that contract, and the limrun worktree
already adds a `leaseProvider` dimension for provider-backed runtime routing.
Without provider-aware device leases, the daemon cannot reject a second agent
before it reaches the iOS runner, and the user sees a backend helper ownership
error instead of a clear device contention error.

## Current state

- `src/daemon/lease-registry.ts` owns lease state. Today `SimulatorLease`
  contains `leaseId`, `tenantId`, `runId`, `backend`, `createdAt`,
  `heartbeatAt`, and `expiresAt`.
- The limrun integration worktree at
  `/Users/thymikee/.codex/worktrees/20c8/agent-device` extends the same lease
  model with `provider`/`leaseProvider` and routes Limrun inventory by provider
  plus lease id. Preserve that dimension if it has landed before this plan is
  executed.
- `src/daemon/lease-registry.ts` currently binds leases by
  `tenantId:runId:backend`, via `bindingKey(tenantId, runId, backend)`.
- `src/daemon/lease-registry.ts` currently enforces capacity with
  `maxActiveSimulatorLeases` and only counts `backend === 'ios-simulator'`.
- `src/daemon/handlers/lease.ts` routes `lease_allocate`, `lease_heartbeat`,
  and `lease_release` into `LeaseRegistry`.
- `src/contracts.ts` exposes lease payloads and schemas. Current metadata
  includes `tenantId`, `runId`, `leaseId`, `leaseTtlMs`, `leaseBackend`, and
  `sessionIsolation`, but not device or client identity. If the limrun worktree
  has landed, it also includes `leaseProvider`; keep it optional and
  provider-neutral.
- `src/remote-connection-state.ts` persists `tenant`, `runId`, `leaseId`,
  `leaseBackend`, platform, target, and runtime hints for `connect`. If the
  limrun worktree has landed, it also persists `leaseProvider`.
- `docs/adr/0002-persistent-platform-helper-sessions.md` says helper sessions
  are daemon-owned, session-scoped resources. Preserve that boundary: this plan
  adds a logical device lease above helper sessions; it does not make runners
  public resources.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Format | `pnpm format` | exit 0 |
| Focused tests | `pnpm exec vitest run src/daemon/__tests__/lease-registry.test.ts src/daemon/__tests__/request-handler-catalog.test.ts` | all tests pass |
| Typecheck | `pnpm typecheck` | exit 0, no errors |

## Scope

**In scope**:
- `docs/adr/0007-remote-device-leases.md` (create)
- `CONTEXT.md`
- `src/contracts.ts`
- `src/client-types.ts`
- `src/remote-config-schema.ts`
- `src/remote-connection-state.ts`
- `src/daemon/lease-context.ts`
- `src/daemon/lease-registry.ts`
- `src/daemon/handlers/lease.ts`
- `src/daemon/http-server.ts`
- `src/daemon/__tests__/lease-registry.test.ts`
- `src/daemon/__tests__/request-handler-catalog.test.ts`

**Out of scope**:
- Connection provider behavior. Plan 002 owns `connect proxy` and lazy proxy
  lease acquisition.
- Session admission/cleanup behavior. Plan 003 owns enforcement after `open`.
- iOS runner lease files. Plan 004 owns diagnostics and runner alignment.
- Android or iOS platform command execution changes.

## Git workflow

- Branch: `advisor/001-device-aware-lease-contracts`
- Commit message: `feat: add device-aware lease contracts`
- Do not push or open a PR unless the operator instructed it.

## Steps

### Step 1: Record the architecture decision and vocabulary

Create `docs/adr/0007-remote-device-leases.md`.

The ADR must state:
- A remote device lease is logical ownership of one selected device by one
  remote agent/client for a connection provider such as `proxy`, cloud bridge,
  or `limrun`.
- `connect` establishes a connection profile and client identity; lease
  allocation remains lazy and happens when a device/backend/provider is known.
- A runner/process lease is a backend helper guard and is not a user/client
  ownership boundary.
- `open` is the natural point to acquire a device lease because that is where
  target resolution and session creation meet.
- Commands after `open` must refresh the lease; no activity for five minutes
  should make the device available again.
- The proxy process is expected to be long-lived and self-serve; recovery should
  not require restarting the proxy.

Update `CONTEXT.md` with concise definitions for:
- `Device lease`
- `Device key`
- `Lease provider`
- `Direct proxy client id`
- `Runner/process lease`

Do not duplicate CLI manuals in `CONTEXT.md`.

**Verify**: `rg -n "Device lease|Device key|Lease provider|Direct proxy client id|Runner/process lease" CONTEXT.md docs/adr/0007-remote-device-leases.md` -> all five terms are found.

### Step 2: Extend public lease payloads

In `src/contracts.ts`, add optional fields to daemon request metadata and lease
RPC payload schemas:

- `deviceKey?: string`
- `clientId?: string`
- `leaseProvider?: string` if it is not already present from the limrun worktree.

Use the existing schema helper style near `leaseAllocateSchema`,
`leaseHeartbeatSchema`, and `leaseReleaseSchema`. Add validation helpers that
accept only bounded, printable, agent-safe identifiers:

- `deviceKey`: 1-256 chars, no whitespace-only value.
- `clientId`: 1-128 chars, letters, numbers, dot, underscore, hyphen.
- `leaseProvider`: 1-64 chars, letters, numbers, dot, underscore, hyphen.

In `src/client-types.ts`, `src/remote-config-schema.ts`, and
`src/remote-connection-state.ts`, expose/persist the same optional fields where
lease state is represented. Do not require the fields yet;
backward-compatible remote runtime leases must still compile.

**Verify**: `pnpm typecheck` -> exits 0.

### Step 3: Make `LeaseRegistry` device-aware

In `src/daemon/lease-registry.ts`:

- Rename `SimulatorLease` to `DeviceLease` only if you keep a compatibility
  alias: `export type SimulatorLease = DeviceLease;`. Prefer `DeviceLease`
  internally. This alias is required because the limrun worktree imports
  `SimulatorLease` from `src/daemon/lease-registry.ts`.
- Add optional `deviceKey?: string` and `clientId?: string` to the lease record.
- Preserve optional `provider?: string`/`leaseProvider?: string` if present, or
  add one normalized provider field if it has not landed yet.
- Add `deviceKey?: string` and `clientId?: string` to allocate, heartbeat,
  release, and admission request types.
- Add provider to allocate, heartbeat, release, and admission request types.
- Keep old backend-only/provider-less leases working when `deviceKey` and
  `leaseProvider` are omitted.
- Change idempotent allocation binding from `tenantId:runId:backend` to include
  provider and `deviceKey` when present. A suggested key shape is
  `${tenantId}:${runId}:${backend}:${provider ?? 'default'}:${deviceKey ?? '*'}`.
- Add a separate `deviceBindings` map keyed by
  `${backend}:${provider ?? 'default'}:${deviceKey}`. When a new active lease
  asks for a device key already bound to a different lease for the same
  backend/provider, throw:
  - code: `COMMAND_FAILED`
  - message: `Device is already leased`
  - details reason: `DEVICE_LEASE_BUSY`
  - include `deviceKey`, `backend`, `leaseProvider`, `leaseId`, `tenantId`,
    `runId`, `expiresAt`, and a hint saying to retry after the lease expires or
    close the owning session.
- On heartbeat/release/admission, if `deviceKey`, `clientId`, or
  `leaseProvider` is supplied, it must match the active lease.
- `cleanupExpiredLeases()` must remove both run bindings and device bindings.

Keep `DEFAULT_LEASE_TTL_MS` at 60 seconds for now. Plan 002 sets the direct
proxy TTL explicitly to five minutes.

**Verify**: `pnpm exec vitest run src/daemon/__tests__/lease-registry.test.ts` -> existing tests pass before adding new ones.

### Step 4: Cover device contention and matching

Extend `src/daemon/__tests__/lease-registry.test.ts` with behavioral tests:

- allocating the same `tenantId`/`runId`/`backend`/`deviceKey` returns the same
  lease and refreshes expiry when provider also matches.
- allocating a different tenant/run for the same `backend` and `deviceKey`
  and provider throws `DEVICE_LEASE_BUSY`.
- allocating the same `deviceKey` for different providers succeeds; provider
  routing must remain isolated for limrun/cloud/proxy.
- allocating two different `deviceKey` values succeeds even when backend is the
  same.
- heartbeat with the wrong `deviceKey` or provider throws
  `LEASE_SCOPE_MISMATCH`.
- expired device leases are removed from `deviceBindings` and a new client can
  allocate the device.
- old backend-only leases still pass the existing tests.

**Verify**: `pnpm exec vitest run src/daemon/__tests__/lease-registry.test.ts` -> all tests pass and at least five new tests cover device-aware behavior.

### Step 5: Thread fields through the lease RPC layer

Update:

- `src/daemon/lease-context.ts` to resolve `deviceKey` and `clientId` from
  `req.meta` or `req.flags` where appropriate, and resolve `leaseProvider`
  from the same source if present.
- `src/daemon/handlers/lease.ts` to pass the resolved fields to
  `allocateLease`, `heartbeatLease`, and `releaseLease`.
- `src/daemon/http-server.ts` to parse `deviceKey`, `clientId`, and
  `leaseProvider` from JSON-RPC params into daemon request metadata for lease
  RPC methods.
- `src/daemon/__tests__/request-handler-catalog.test.ts` to assert lease
  handler responses preserve `deviceKey`, `clientId`, and `leaseProvider` when
  supplied.

Do not add user-facing CLI flags in this step. Connection providers in Plan 002
should set these fields internally through generated profiles and request
metadata.

**Verify**: `pnpm exec vitest run src/daemon/__tests__/lease-registry.test.ts src/daemon/__tests__/request-handler-catalog.test.ts` -> all tests pass.

## Test plan

- Primary tests: `src/daemon/__tests__/lease-registry.test.ts`.
- Handler projection test: `src/daemon/__tests__/request-handler-catalog.test.ts`.
- Run `pnpm typecheck` to prove public contract fields compile across client
  and daemon types.

## Done criteria

- [ ] `docs/adr/0007-remote-device-leases.md` exists and defines logical
  provider-aware device leases versus runner/process leases.
- [ ] `CONTEXT.md` includes the five new vocabulary entries.
- [ ] Lease payload schemas accept optional `deviceKey`, `clientId`, and
  `leaseProvider`.
- [ ] `LeaseRegistry` rejects active same-device conflicting leases with
  `DEVICE_LEASE_BUSY` only within the same backend/provider.
- [ ] Backend-only lease tests still pass.
- [ ] `pnpm format`, focused tests, and `pnpm typecheck` exit 0.
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report if:

- Existing lease RPC payloads are generated from a different contract source
  than `src/contracts.ts`.
- Adding `deviceKey` requires changing platform dispatch or target resolution;
  that belongs in Plan 002 or Plan 003. This plan only adds the contract and
  registry semantics.
- `leaseProvider` has already landed under a different public field name. In
  that case, preserve the landed field and update this plan's names before
  coding.
- Any public result type currently named `SimulatorLease` is consumed outside
  this package in a way that makes renaming a breaking change. Use the alias
  instead.
- Focused lease tests fail twice after a reasonable fix attempt.

## Maintenance notes

- Reviewers should scrutinize compatibility: old tenant/run/backend leases must
  keep working.
- The busy error is part of the user experience. Keep it short and actionable.
- Do not weaken the iOS runner file lease. This plan adds a higher-level
  logical lease, not a replacement for process mutual exclusion.
