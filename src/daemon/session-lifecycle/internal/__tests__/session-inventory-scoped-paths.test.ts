import { test, expect } from 'vitest';
import path from 'node:path';
import { handleSessionInventoryCommands } from '../inventory.ts';
import { makeSessionStore } from '../../../../__tests__/test-utils/store-factory.ts';
import type { DaemonRequest, DaemonResponse, SessionState } from '../../../types.ts';
import { IOS_SIMULATOR } from '../../../../__tests__/test-utils/device-fixtures.ts';
import { resolveImplicitSessionScope } from '../../../session-routing.ts';
import { tenantScopedSessionName } from '../../../session-tenant-scope.ts';

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
  sessionStore.set(SCOPED_KEY, scopedSession());
  const req: DaemonRequest = {
    token: 't',
    session: 'default',
    command: 'session_list',
    positionals: [],
    flags: {},
  };
  return await handleSessionInventoryCommands({
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
  sessionStore.set(callerSessionAddress, {
    ...scopedSession(),
    sessionScope: callerScope,
  });
  sessionStore.set('qa-cart-integrity', {
    ...scopedSession(),
    name: 'qa-cart-integrity',
    sessionScope: { kind: 'named-local' },
  });
  sessionStore.set('tenant-a:qa', {
    ...scopedSession(),
    name: 'tenant-a:qa',
    sessionScope: { kind: 'named-local' },
  });
  sessionStore.set('default', {
    ...scopedSession(),
    sessionScope: { kind: 'global-default' },
  });
  sessionStore.set('cwd:other:default', {
    ...scopedSession(),
    sessionScope: { kind: 'cwd', id: 'other' },
  });
  const tenantSessionAddress = tenantScopedSessionName('tenant-a', 'remote-recording');
  sessionStore.set(tenantSessionAddress, {
    ...scopedSession(),
    name: tenantSessionAddress,
    sessionScope: { kind: 'tenant', id: 'tenant-a' },
  });

  const response = await handleSessionInventoryCommands({
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
    sessionStore.set(address, {
      ...scopedSession(),
      name: address,
      sessionScope: { kind: 'tenant', id: tenantId },
    });
  }
  for (const address of ['qa-cart-integrity', 'tenant-a:qa']) {
    sessionStore.set(address, {
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
