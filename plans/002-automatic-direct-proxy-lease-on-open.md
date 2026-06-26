# Plan 002: Add proxy as a connect provider

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report; do not improvise. When done, update the status row for this plan in
> `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 04f53bbc0..HEAD -- src/cli src/client-normalizers.ts src/client-types.ts src/commands src/contracts.ts src/remote-config-schema.ts src/remote-connection-state.ts src/daemon/handlers/session-open.ts src/daemon/__tests__/request-router-open.test.ts test/integration/smoke-open-remote-config.test.ts`
>
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: `plans/001-device-aware-lease-contracts.md`
- **Category**: correctness | dx
- **Planned at**: commit `04f53bbc0`, 2026-06-26

## Why this matters

Cloud and remote-config flows already use `connect` as the user-facing
connection lifecycle: authenticate or resolve a profile, persist
`RemoteConnectionState`, then let later commands allocate or refresh the lease.
The limrun worktree follows the same pattern with `connect limrun`. Direct
proxy should not grow a parallel state machine. It should become another
connection provider, so agents use one mental model across self-hosted proxy,
agent-device-cloud, and limrun.

## Current state

- `src/cli/commands/connection.ts` implements `connect`, `disconnect`, and
  `connection status`. Without `--remote-config`, it resolves a cloud
  connection profile.
- `src/cli/commands/connection-runtime.ts` materializes remote config state on
  non-deferred commands, allocates or heartbeats a lease, updates persisted
  state, and prepares Metro on `open`.
- `src/remote-connection-state.ts` persists connection state under
  `remote-connections`, including remote config path/hash, sanitized daemon
  state, `tenant`, `runId`, `leaseId`, `leaseBackend`, platform, target, and
  runtime hints.
- `src/cli/cloud-connection-profile.ts` fetches a cloud connection profile and
  writes a generated remote config.
- The limrun worktree at
  `/Users/thymikee/.codex/worktrees/20c8/agent-device` adds
  `connect limrun`, `src/cli/generated-remote-config.ts`,
  `src/cli/limrun-connection-profile.ts`, `leaseProvider`, and provider-backed
  cloud runtimes. Reuse that shape if it has landed before this plan executes.
- `src/cli/commands/proxy.ts` starts a long-lived proxy and prints a shared
  proxy URL/token. It does not create a per-agent connection profile.
- `src/utils/cli-help.ts` currently says direct proxy users should not use
  `connect`, tenant, run, or lease flags. This must be changed after behavior
  exists.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Format | `pnpm format` | exit 0 |
| Focused CLI tests | `pnpm exec vitest run src/__tests__/remote-connection.test.ts src/__tests__/cloud-connect-profile.test.ts src/utils/__tests__/args.test.ts` | all tests pass |
| Remote smoke | `node --test test/integration/smoke-open-remote-config.test.ts` | all tests pass |
| Open route tests | `pnpm exec vitest run src/daemon/__tests__/request-router-open.test.ts` | all tests pass |
| Typecheck | `pnpm typecheck` | exit 0, no errors |

## Scope

**In scope**:
- `src/cli/generated-remote-config.ts` (create if not already present)
- `src/cli/proxy-connection-profile.ts` (create)
- `src/cli/cloud-connection-profile.ts`
- `src/cli/commands/connection.ts`
- `src/cli/commands/connection-runtime.ts`
- `src/remote-config-schema.ts`
- `src/remote-connection-state.ts`
- `src/client-normalizers.ts`
- `src/client-types.ts`
- `src/commands/command-projection.ts`
- `src/daemon/handlers/session-open.ts`
- `src/daemon/__tests__/request-router-open.test.ts`
- `src/__tests__/remote-connection.test.ts`
- `src/__tests__/cloud-connect-profile.test.ts`
- `src/utils/__tests__/args.test.ts`
- `test/integration/smoke-open-remote-config.test.ts`

**Out of scope**:
- Changing the proxy server token model.
- Replacing cloud auth or the cloud connection profile endpoint.
- Reworking limrun runtime internals.
- Session cleanup on expiry. Plan 003 owns inactivity cleanup.
- User-facing help/docs updates beyond parse tests. Plan 004 owns final copy.

## Git workflow

- Branch: `advisor/002-connect-proxy-provider`
- Commit message: `feat: add proxy connect provider`
- Do not push or open a PR unless the operator instructed it.

## Steps

### Step 1: Extract generated remote config helpers

If `src/cli/generated-remote-config.ts` does not already exist, extract the
generated-profile writer from `src/cli/cloud-connection-profile.ts`.

The helper should provide:

```ts
writeGeneratedRemoteConfig({
  stateDir,
  provider,
  profile,
}): string

resolveGeneratedRemoteConfigProfile({
  configPath,
  cwd,
  env,
  provider,
}): ResolvedRemoteConfigProfile
```

Requirements:

- Write under `${stateDir}/remote-connections/generated`.
- Include the provider name and a profile hash in the file name.
- Write mode `0o600` and avoid storing secrets.
- Keep cloud behavior byte-for-byte equivalent except for the generated file
  name prefix changing from hard-coded `cloud` to provider-driven `cloud`.

**Verify**: `pnpm exec vitest run src/__tests__/cloud-connect-profile.test.ts` -> existing cloud generated-profile tests pass.

### Step 2: Add a proxy connection profile resolver

Create `src/cli/proxy-connection-profile.ts`.

It should build a generated remote config for `connect proxy` from flags/env:

- `daemonBaseUrl`: required from `--daemon-base-url`,
  `AGENT_DEVICE_DAEMON_BASE_URL`, or a proxy-specific flag if one already
  exists.
- `daemonAuthToken`: optional from existing daemon auth sources.
- `daemonTransport`: default `http` for explicit proxy URLs unless the user
  overrides it.
- `tenant`: default `proxy`.
- `runId`: stable per local state dir and proxy base URL, such as
  `proxy-${clientId}`.
- `clientId`: generated once per state dir and proxy base URL, non-secret, safe
  identifier. Store it in the generated profile or connection state only if
  Plan 001 added the field; otherwise store enough data to reproduce the same
  run id.
- `sessionIsolation`: `tenant`.
- `leaseProvider`: `proxy` if Plan 001 added provider support.
- `leaseBackend`: infer from `--platform ios|android` when supplied, otherwise
  leave pending so the first device command can resolve it.
- `leaseTtlMs`: 300,000 ms if Plan 001 exposed it through connection/profile
  defaults; otherwise set it when allocating/heartbeating in Step 4.
- `platform`, `target`, `device`, `udid`, `serial`, `session`, and Metro fields
  should pass through from flags like cloud/remote config does.

Do not put the shared proxy bearer token in the generated remote config unless
the current remote config contract already stores daemon auth there. Prefer the
existing sanitized daemon state and environment auth behavior.

**Verify**: add tests proving `connect proxy` with a daemon base URL writes a
generated profile with tenant/run/session isolation and no raw token value.

### Step 3: Route `connect` through providers

Update `src/cli/commands/connection.ts` so `connect` accepts at most one
provider positional:

- `agent-device connect` keeps current cloud behavior.
- `agent-device connect --remote-config ./remote.json` keeps current explicit
  remote-config behavior.
- `agent-device connect proxy --daemon-base-url http://host:port/agent-device`
  uses `resolveProxyConnectProfile`.
- If the limrun worktree has landed, preserve `agent-device connect limrun`.

Rules:

- Provider positional and `--remote-config` are mutually exclusive.
- Unknown provider errors must list supported providers. At minimum:
  `proxy`; include `limrun` if present.
- `connect proxy` requires a daemon base URL.
- `connect proxy` should write normal `RemoteConnectionState`; do not create
  a separate direct-proxy state file.

**Verify**: `pnpm exec vitest run src/utils/__tests__/args.test.ts src/__tests__/remote-connection.test.ts` -> tests cover provider positional parsing, unknown provider, and state persistence.

### Step 4: Preserve provider/client/device fields in connection state

Update `src/remote-config-schema.ts`, `src/remote-connection-state.ts`,
`src/client-types.ts`, `src/client-normalizers.ts`, and
`src/commands/command-projection.ts` as needed so optional fields from Plan 001
flow through the same path as tenant/run/lease/backend:

- `leaseProvider`
- `clientId`
- `deviceKey`
- `leaseTtlMs` when present

For remote-config and cloud flows, all fields remain optional. For proxy,
`clientId` and `leaseProvider: proxy` should be persisted.

**Verify**: `pnpm typecheck` -> exits 0.

### Step 5: Make lease allocation device-aware without breaking remote materialization

Current `connection-runtime.ts` allocates leases before most commands based on
backend/provider only. Keep that behavior for providers that do not require a
known physical/local device key, including current cloud/limrun flows.

Add a shared device-aware path for providers that do require a selected device
key. For `connect proxy`, use this path:

- On `open`, resolve the target platform/device before platform side effects.
- Derive a stable `deviceKey`, for example
  `${platform}:${target}:${udid|serial|deviceId}`.
- Allocate or heartbeat the lease with `tenant`, `runId`, `leaseBackend`,
  `leaseProvider: proxy`, `clientId`, `deviceKey`, and `ttlMs: 300_000`.
- Attach the resulting `leaseId`, `leaseProvider`, `clientId`, and `deviceKey`
  to the request metadata before app open/session creation continues.
- Persist the returned lease fields in `RemoteConnectionState`.

Do not allow `open` to mutate the target device before a conflicting proxy
device lease would be detected. If the existing open route cannot expose the
selected `deviceKey` early enough, stop and report; solve that in daemon open
or target-resolution orchestration, not with a post-open retry.

For non-`open` commands:

- If a proxy connection already has `leaseId` and `deviceKey`, heartbeat and
  attach them.
- If a command needs a session but there is no active proxy lease, fail with:
  "No active proxy device lease for this session; run open first."
- `devices` may run after `connect proxy` without a device lease so users can
  inspect inventory.

**Verify**: `pnpm exec vitest run src/daemon/__tests__/request-router-open.test.ts` -> add a test proving a busy proxy device lease rejects `open` before dispatch/open side effects.

### Step 6: Release proxy leases through `disconnect` and `close`

Use the existing `disconnect` flow:

- best-effort close the active session;
- stop Metro/React DevTools cleanup;
- release the persisted lease with tenant/run/provider/client/device metadata;
- remove `RemoteConnectionState`.

Also make `close` release the active proxy lease only for the scoped session
when Plan 003 session ownership metadata is available. Before Plan 003 lands,
`close` should at least close the daemon session and leave `disconnect` as the
full connection cleanup command.

**Verify**: tests show `disconnect` releases with `leaseProvider: proxy` and
removes connection state.

## Test plan

- Extend `src/__tests__/remote-connection.test.ts` for `connect proxy` state,
  provider compatibility, `--force`, and disconnect release.
- Extend `src/utils/__tests__/args.test.ts` for provider positional parsing and
  help examples.
- Extend `src/daemon/__tests__/request-router-open.test.ts` for device-aware
  busy rejection before open side effects.
- Extend `test/integration/smoke-open-remote-config.test.ts` or create a
  focused proxy smoke fixture proving `connect proxy -> open -> snapshot ->
  disconnect` sends tenant/run/lease/provider metadata.

## Done criteria

- [ ] `agent-device connect proxy --daemon-base-url ...` creates normal
  `RemoteConnectionState`.
- [ ] No separate direct-proxy lease-state file exists.
- [ ] Proxy connection state includes a stable non-secret client identity.
- [ ] Proxy `open` acquires a five-minute device-aware lease before mutating
  the target device/app.
- [ ] Commands after proxy `open` attach lease metadata automatically.
- [ ] `disconnect` releases the proxy lease and removes connection state.
- [ ] Cloud, explicit remote-config, and limrun connect flows still work.
- [ ] `pnpm format`, focused tests, and `pnpm typecheck` exit 0.
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report if:

- The open path cannot know the selected `deviceKey` before side effects.
- `connect proxy` cannot be represented as a generated remote config without
  persisting secrets.
- Provider positional parsing conflicts with existing `connect --remote-config`
  or cloud implicit login semantics.
- Limrun provider fields have landed under names that conflict with
  `leaseProvider`, `clientId`, or `deviceKey`.
- Focused tests fail twice after a reasonable fix attempt.

## Maintenance notes

- `connect` owns connection/profile identity. Lease allocation remains lazy.
- Provider-specific runtime allocation belongs behind daemon/bridge providers;
  ordinary command users should not see limrun/proxy internals.
- Reviewers should focus on the first command after `connect proxy`: inventory
  may be lease-free, but device mutation must not bypass lease acquisition.
