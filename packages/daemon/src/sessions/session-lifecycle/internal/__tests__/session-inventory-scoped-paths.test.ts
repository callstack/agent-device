import type { DaemonResponse } from '@agent-device/kernel/contracts';
import { daemonPlatformServicesFixture } from '../../../../__tests__/support/platform-services-fixture.ts';
import { test, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { handleSessionInventoryCommands } from '../inventory.ts';
import { makeSessionStore } from '../../../../__tests__/support/store-factory.ts';
import type { DaemonRequest } from '../../../../core/daemon-request.ts';
import type { SessionState } from '../../../../core/session-state.ts';
import {
  IOS_SIMULATOR,
  createTestHostEnvironment,
  mkdtempForTestSync,
} from '@agent-device/test-kit';
import { resolveImplicitSessionScope, resolveSessionScope } from '../../../session-routing.ts';
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

// #4908: on a proxy shared by several clients under one token, the tenant label is something any
// holder of that token can send, so it cannot be what keeps one client's session name out of
// another client's `session list`. A session that holds a lease is listed only for the request that
// sends that lease's id.

function tenantSession(tenantId: string, leaseId?: string): SessionState {
  const address = tenantScopedSessionName(tenantId, leaseId ? 'leased' : 'idle');
  return {
    name: address,
    sessionScope: { kind: 'tenant', id: tenantId },
    device: IOS_SIMULATOR,
    createdAt: Date.now(),
    actions: [],
    ...(leaseId
      ? { lease: { tenantId, runId: 'run-leased', leaseId, leaseProvider: 'proxy' } }
      : {}),
  };
}

async function runTenantSessionList(req: DaemonRequest) {
  const sessionStore = makeSessionStore('agent-device-inventory-lease-');
  for (const session of [
    tenantSession('tenant-a'),
    tenantSession('tenant-a', 'a'.repeat(32)),
    tenantSession('tenant-b'),
  ]) {
    sessionStore.publish(session.name, session);
  }
  const response = await handleSessionInventoryCommands({
    host: createTestHostEnvironment(),
    platformServices: daemonPlatformServicesFixture(),
    req,
    sessionName: req.session,
    sessionStore,
  });
  expect(response?.ok).toBe(true);
  if (!response?.ok) return [];
  const sessions = response.data?.sessions as { address: string }[];
  return sessions.map((session) => session.address);
}

function tenantRequest(meta: DaemonRequest['meta']): DaemonRequest {
  return {
    token: 't',
    session: tenantScopedSessionName('tenant-a', 'idle'),
    command: 'session_list',
    positionals: [],
    flags: {},
    meta: { tenantId: 'tenant-a', sessionIsolation: 'tenant', ...meta },
  };
}

test('session list shows a tenant session that holds a lease only to the request sending that lease id', async () => {
  const idleAddress = tenantScopedSessionName('tenant-a', 'idle');
  const leasedAddress = tenantScopedSessionName('tenant-a', 'leased');

  expect(await runTenantSessionList(tenantRequest(undefined))).toEqual([idleAddress]);
  expect(await runTenantSessionList(tenantRequest({ leaseId: 'a'.repeat(32) }))).toEqual([
    idleAddress,
    leasedAddress,
  ]);
  expect(await runTenantSessionList(tenantRequest({ leaseId: 'b'.repeat(32) }))).toEqual([
    idleAddress,
  ]);
});

test('session list keeps a tenant session hidden from a request that sends its lease id without tenant isolation', async () => {
  const req: DaemonRequest = {
    token: 't',
    session: 'default',
    command: 'session_list',
    positionals: [],
    flags: {},
    meta: { cwd: '/tmp/shop-app', leaseId: 'a'.repeat(32) },
  };
  expect(await runTenantSessionList(req)).toEqual([]);
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

test('session list judges every session against one workspace even if the cwd realpath changes', async () => {
  const workspaceA = fs.realpathSync.native(mkdtempForTestSync('agent-device-inventory-ws-a-'));
  const workspaceB = fs.realpathSync.native(mkdtempForTestSync('agent-device-inventory-ws-b-'));
  const scopeOf = (cwd: string) =>
    resolveSessionScope({
      token: 't',
      session: 'default',
      command: 'session_list',
      positionals: [],
      meta: { cwd },
    });
  const sessionStore = makeSessionStore('agent-device-inventory-one-scope-');
  for (const [name, cwd] of [
    ['a-1', workspaceA],
    ['b-1', workspaceB],
    ['a-2', workspaceA],
    ['b-2', workspaceB],
  ] as const) {
    sessionStore.publish(name, {
      name,
      sessionScope: scopeOf(cwd),
      device: IOS_SIMULATOR,
      createdAt: Date.now(),
      actions: [],
    });
  }
  // The first resolution sees workspace A; any later one would see workspace B.
  const realpath = vi
    .spyOn(fs.realpathSync, 'native')
    .mockImplementationOnce(() => workspaceA)
    .mockImplementation(() => workspaceB);

  try {
    const response = await handleSessionInventoryCommands({
      host: createTestHostEnvironment(),
      platformServices: daemonPlatformServicesFixture(),
      req: {
        token: 't',
        session: 'default',
        command: 'session_list',
        positionals: [],
        flags: {},
        meta: { cwd: workspaceA },
      },
      sessionName: 'default',
      sessionStore,
    });

    expect(response?.ok).toBe(true);
    if (!response?.ok) return;
    const sessions = (response.data?.sessions ?? []) as { name: string }[];
    const names = sessions.map((session) => session.name);
    expect(names.sort()).toEqual(['a-1', 'a-2']);
    expect(realpath).toHaveBeenCalledTimes(1);
  } finally {
    realpath.mockRestore();
  }
});
