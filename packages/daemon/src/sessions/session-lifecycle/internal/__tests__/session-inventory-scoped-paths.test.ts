import type { DaemonResponse } from '@agent-device/kernel/contracts';
import { daemonPlatformServicesFixture } from '../../../../__tests__/support/platform-services-fixture.ts';
import { isolatedDeviceClaimStores } from '../../../../__tests__/support/device-claim-store.ts';
import { test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { handleSessionInventoryCommands } from '../inventory.ts';
import { makeSessionStore } from '../../../../__tests__/support/store-factory.ts';
import type { DaemonRequest } from '../../../../core/daemon-request.ts';
import type { SessionState } from '../../../../core/session-state.ts';
import { IOS_SIMULATOR, createTestHostEnvironment } from '@agent-device/test-kit';
import { readCurrentOwnerIdentity } from '@agent-device/host-kit/process';
import { resolveImplicitSessionScope } from '../../../session-routing.ts';
import { tenantScopedSessionName } from '../../../../core/session-tenant-scope.ts';

// A session opened without an explicit --session is NAMED `default` and STORED under
// `cwd:<hash>:default`. `session list` resolved its paths from the name, so it answered with
// `<state>/sessions/default` — a directory that does not exist — while the session's real
// artifacts (runner.log included) sat in `<state>/sessions/cwd_<hash>_default` (#2031/#1394).

const SCOPED_KEY = 'cwd:8bea844ab16aa9b3:default';

function scopedSession(): SessionState {
  return {
    name: 'default',
    sessionScope: { kind: 'cwd', id: '8bea844ab16aa9b3' },
    device: IOS_SIMULATOR,
    createdAt: Date.now(),
    actions: [],
  };
}

async function runSessionList(): Promise<DaemonResponse | null> {
  const sessionStore = makeSessionStore('agent-device-inventory-scoped-');
  sessionStore.publish(SCOPED_KEY, scopedSession());
  const req: DaemonRequest = {
    token: 't',
    session: 'default',
    command: 'session_list',
    positionals: [],
    flags: {},
  };
  return await handleSessionInventoryCommands({
    host: createTestHostEnvironment(),
    platformServices: daemonPlatformServicesFixture(),
    req,
    sessionName: SCOPED_KEY,
    sessionStore,
  });
}

test('session list returns the caller cwd and local named sessions without crossing cwd or tenant ownership', async () => {
  const sessionStore = makeSessionStore('agent-device-inventory-scoped-');
  const req: DaemonRequest = {
    token: 't',
    session: 'default',
    command: 'session_list',
    positionals: [],
    flags: {},
    meta: { cwd: '/tmp/shop-app' },
  };
  const callerScope = resolveImplicitSessionScope(req)!;
  const callerSessionAddress = `cwd:${callerScope.id}:default`;
  sessionStore.publish(callerSessionAddress, {
    ...scopedSession(),
    sessionScope: callerScope,
  });
  sessionStore.publish('qa-cart-integrity', {
    ...scopedSession(),
    name: 'qa-cart-integrity',
    sessionScope: { kind: 'named-local' },
  });
  sessionStore.publish('tenant-a:qa', {
    ...scopedSession(),
    name: 'tenant-a:qa',
    sessionScope: { kind: 'named-local' },
  });
  sessionStore.publish('default', {
    ...scopedSession(),
    sessionScope: { kind: 'global-default' },
  });
  sessionStore.publish('cwd:other:default', {
    ...scopedSession(),
    sessionScope: { kind: 'cwd', id: 'other' },
  });
  const tenantSessionAddress = tenantScopedSessionName('tenant-a', 'remote-recording');
  sessionStore.publish(tenantSessionAddress, {
    ...scopedSession(),
    name: tenantSessionAddress,
    sessionScope: { kind: 'tenant', id: 'tenant-a' },
  });

  const response = await handleSessionInventoryCommands({
    host: createTestHostEnvironment(),
    platformServices: daemonPlatformServicesFixture(),
    req,
    sessionName: callerSessionAddress,
    sessionStore,
  });

  expect(response?.ok).toBe(true);
  if (!response?.ok) return;
  const sessions = response.data?.sessions as { name: string; address: string }[];
  expect(sessions).toEqual([
    expect.objectContaining({ name: 'default', address: callerSessionAddress }),
    expect.objectContaining({ name: 'qa-cart-integrity', address: 'qa-cart-integrity' }),
    expect.objectContaining({ name: 'tenant-a:qa', address: 'tenant-a:qa' }),
  ]);
});

test('session list returns only sessions owned by the requesting tenant', async () => {
  const sessionStore = makeSessionStore('agent-device-inventory-tenant-');
  for (const tenantId of ['tenant-a', 'tenant-b']) {
    const address = tenantScopedSessionName(tenantId, 'default');
    sessionStore.publish(address, {
      ...scopedSession(),
      name: address,
      sessionScope: { kind: 'tenant', id: tenantId },
    });
  }
  for (const address of ['qa-cart-integrity', 'tenant-a:qa']) {
    sessionStore.publish(address, {
      ...scopedSession(),
      name: address,
      sessionScope: { kind: 'named-local' },
    });
  }
  const req: DaemonRequest = {
    token: 't',
    session: tenantScopedSessionName('tenant-a', 'default'),
    command: 'session_list',
    positionals: [],
    flags: {},
    meta: { tenantId: 'tenant-a', sessionIsolation: 'tenant' },
  };

  const response = await handleSessionInventoryCommands({
    host: createTestHostEnvironment(),
    platformServices: daemonPlatformServicesFixture(),
    req,
    sessionName: req.session,
    sessionStore,
  });

  expect(response?.ok).toBe(true);
  if (!response?.ok) return;
  const sessions = response.data?.sessions as { address: string }[];
  expect(sessions).toEqual([
    expect.objectContaining({ address: tenantScopedSessionName('tenant-a', 'default') }),
  ]);
});

test('session list resolves a cwd-scoped session directory from its store key', async () => {
  const response = await runSessionList();

  expect(response?.ok).toBe(true);
  if (!response?.ok) return;
  const sessions = response.data?.sessions as {
    name: string;
    sessionStateDir: string;
    runnerLogPath: string;
  }[];
  expect(sessions).toHaveLength(1);
  const session = sessions[0]!;
  // The public name stays what the caller typed …
  expect(session.name).toBe('default');
  // … while the reported paths point at the directory that actually holds the session.
  expect(path.basename(session.sessionStateDir)).toBe('cwd_8bea844ab16aa9b3_default');
  expect(session.runnerLogPath.startsWith(`${session.sessionStateDir}${path.sep}`)).toBe(true);
});

type ClaimEntry = {
  device: string;
  deviceId: string;
  claimedBy: { session: string; workspace: string };
};

function writeLiveDeviceClaim(
  claimsDir: string,
  claim: { id: string; session: string; workspace: string },
): void {
  const owner = readCurrentOwnerIdentity();
  fs.mkdirSync(claimsDir, { recursive: true });
  fs.writeFileSync(
    path.join(claimsDir, `${claim.id}.json`),
    JSON.stringify({
      schemaVersion: 1,
      deviceKey: `local:android:none:${claim.id}`,
      device: { platform: 'android', id: claim.id, name: claim.id, kind: 'emulator' },
      session: claim.session,
      workspace: claim.workspace,
      stateDir: process.cwd(),
      ownerPid: owner.pid,
      ownerStartTime: owner.startTime,
      ownerToken: `${claim.id}-token`,
      createdAtMs: 1,
      updatedAtMs: 1,
    }),
  );
}

// Device claims are host-global, so every advisory assertion answers an isolated claim root.
const setupClaims = isolatedDeviceClaimStores('agent-device-session-list-claims-');

function scopedSessionListRequest(cwd: string) {
  const req: DaemonRequest = {
    token: 't',
    session: 'default',
    command: 'session_list',
    positionals: [],
    flags: {},
    meta: { cwd },
  };
  const scope = resolveImplicitSessionScope(req)!;
  return {
    callerSessionAddress: `cwd:${scope.id}:default`,
    callerScope: scope,
    run: (sessionStore: ReturnType<typeof makeSessionStore>) =>
      handleSessionInventoryCommands({
        host: createTestHostEnvironment(),
        platformServices: daemonPlatformServicesFixture(),
        req,
        sessionName: `cwd:${scope.id}:default`,
        sessionStore,
      }),
  };
}

test('session list names the devices sessions outside its scope hold', async () => {
  const { claimsDir } = setupClaims();
  const sessionStore = makeSessionStore('agent-device-inventory-foreign-claims-');
  const list = scopedSessionListRequest('/worktrees/caller');
  sessionStore.publish(list.callerSessionAddress, {
    ...scopedSession(),
    sessionScope: list.callerScope,
  });
  // A session another workspace of the same daemon owns, invisible from the caller's scope.
  sessionStore.publish('cwd:other-hash:default', {
    ...scopedSession(),
    sessionScope: { kind: 'cwd', id: 'other-hash' },
  });
  writeLiveDeviceClaim(claimsDir, {
    id: 'emulator-5554',
    session: 'cwd:other-hash:default',
    workspace: '/worktrees/other',
  });
  // A claim whose owner answers to a state this store does not know.
  writeLiveDeviceClaim(claimsDir, {
    id: 'emulator-5556',
    session: 'cwd:gone-hash:default',
    workspace: '/worktrees/gone',
  });

  const response = await list.run(sessionStore);

  expect(response?.ok).toBe(true);
  if (!response?.ok) return;
  const foreign = response.data?.claimedByOtherSessions as ClaimEntry[] | undefined;
  expect(foreign).toEqual([
    {
      device: 'emulator-5554',
      deviceId: 'emulator-5554',
      claimedBy: { session: 'cwd:other-hash:default', workspace: '/worktrees/other' },
    },
    {
      device: 'emulator-5556',
      deviceId: 'emulator-5556',
      claimedBy: { session: 'cwd:gone-hash:default', workspace: '/worktrees/gone' },
    },
  ]);
});

test('session list stays silent about devices its own scope holds', async () => {
  const { claimsDir } = setupClaims();
  const sessionStore = makeSessionStore('agent-device-inventory-own-claims-');
  const list = scopedSessionListRequest('/worktrees/caller');
  sessionStore.publish(list.callerSessionAddress, {
    ...scopedSession(),
    sessionScope: list.callerScope,
  });
  writeLiveDeviceClaim(claimsDir, {
    id: 'emulator-5554',
    session: list.callerSessionAddress,
    workspace: '/worktrees/caller',
  });

  const response = await list.run(sessionStore);

  expect(response?.ok).toBe(true);
  if (!response?.ok) return;
  expect(response.data?.claimedByOtherSessions).toBeUndefined();
});

test('session list stays silent about devices a sibling session of its own scope holds', async () => {
  const { claimsDir } = setupClaims();
  const sessionStore = makeSessionStore('agent-device-inventory-sibling-claims-');
  const list = scopedSessionListRequest('/worktrees/caller');
  sessionStore.publish(list.callerSessionAddress, {
    ...scopedSession(),
    sessionScope: list.callerScope,
  });
  // A named-local session answers the caller's cwd scope, so a device it holds is not foreign.
  sessionStore.publish('qa-cart-integrity', {
    ...scopedSession(),
    name: 'qa-cart-integrity',
    sessionScope: { kind: 'named-local' },
  });
  writeLiveDeviceClaim(claimsDir, {
    id: 'emulator-5554',
    session: 'qa-cart-integrity',
    workspace: '/worktrees/caller',
  });

  const response = await list.run(sessionStore);

  expect(response?.ok).toBe(true);
  if (!response?.ok) return;
  expect(response.data?.claimedByOtherSessions).toBeUndefined();
});

test('session list leaves out foreign claims no live owner can release', async () => {
  const { claimsDir } = setupClaims();
  const sessionStore = makeSessionStore('agent-device-inventory-dead-claims-');
  fs.mkdirSync(claimsDir, { recursive: true });
  fs.writeFileSync(
    path.join(claimsDir, 'emulator-5554.json'),
    JSON.stringify({
      schemaVersion: 1,
      deviceKey: 'local:android:none:emulator-5554',
      device: {
        platform: 'android',
        id: 'emulator-5554',
        name: 'emulator-5554',
        kind: 'emulator',
      },
      session: 'cwd:other-hash:default',
      workspace: '/worktrees/other',
      stateDir: process.cwd(),
      ownerPid: 999_999_999,
      ownerStartTime: 'long-gone',
      ownerToken: 'emulator-5554-token',
      createdAtMs: 1,
      updatedAtMs: 1,
    }),
  );

  const response = await scopedSessionListRequest('/worktrees/caller').run(sessionStore);

  expect(response?.ok).toBe(true);
  if (!response?.ok) return;
  expect(response.data?.claimedByOtherSessions).toBeUndefined();
});
