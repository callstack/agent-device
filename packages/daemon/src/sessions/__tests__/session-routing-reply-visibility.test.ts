import path from 'node:path';
import { expect, test } from 'vitest';
import { IOS_SIMULATOR, mkdtempForTestSync } from '@agent-device/test-kit';
import { makeSessionStore } from '../../__tests__/support/store-factory.ts';
import { makeIosAppSession } from '../../__tests__/support/session-factories.ts';
import type { DaemonRequest } from '../../core/daemon-request.ts';
import { SessionStore } from '../../core/session-store.ts';
import { claimOwnerVisible, dropInvisibleClaimOwner, mayNameSession } from '../session-routing.ts';
import type { DaemonResponse } from '@agent-device/kernel/contracts';

// A reply names the session a host-global device claim records as its owner unless that owner is
// another proxy client's: a leased or tenant-scoped session the request may not see (#4923). The
// claim's `stateDir` says which daemon wrote it; the store and the naming rule decide the rest.

const TENANT = 'e2b';

function request(overrides: Partial<DaemonRequest['meta']> = {}): DaemonRequest {
  return {
    command: 'open',
    token: 'test-token',
    session: 'agentB',
    positionals: [],
    flags: {},
    meta: {
      requestId: 'req-claim-visibility',
      tenantId: TENANT,
      sessionIsolation: 'tenant',
      ...overrides,
    },
  };
}

function storeWithLeasedSession(): SessionStore {
  const store = makeSessionStore('agent-device-reply-visibility-');
  store.publish(
    'e2b:agentA',
    makeIosAppSession('e2b:agentA', {
      sessionScope: { kind: 'tenant', id: TENANT },
      lease: { leaseId: 'lease-a', tenantId: TENANT, runId: 'run-a' },
    }),
  );
  return store;
}

function claimConflictResponse(session: string, stateDir: string): DaemonResponse {
  return {
    ok: false,
    error: {
      code: 'DEVICE_IN_USE',
      message: `apple device sim-1 is owned by session "${session}" in workspace "/work/a".`,
      hint: 'Inspect the owner with: agent-device device status --platform ios --udid sim-1',
      retriable: false,
      details: {
        reason: 'DEVICE_CLAIM_LIVE_OWNER',
        classification: 'live',
        deviceKey: 'local:apple:ios:sim-1',
        owner: { session, workspace: '/work/a', stateDir },
      },
    },
  };
}

test('a claim naming an invisible leased session loses its owner', () => {
  const store = storeWithLeasedSession();

  const response = dropInvisibleClaimOwner(
    request(),
    store,
    claimConflictResponse('e2b:agentA', store.resolveDaemonStateDir()),
  );

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.code).toBe('DEVICE_IN_USE');
  expect(response.error.retriable).toBe(false);
  expect(response.error.message).toBe('Device is already in use by another session.');
  expect(response.error.details?.owner).toBeUndefined();
  expect(response.error.details?.reason).toBe('DEVICE_CLAIM_LIVE_OWNER');
  expect(response.error.hint).toContain('device status');
});

test('the lease holder keeps the named claim-conflict refusal', () => {
  const store = storeWithLeasedSession();

  const response = dropInvisibleClaimOwner(
    request({ leaseId: 'lease-a' }),
    store,
    claimConflictResponse('e2b:agentA', store.resolveDaemonStateDir()),
  );

  expect(response).toMatchObject({
    error: {
      message: expect.stringContaining('e2b:agentA'),
      details: { owner: { session: 'e2b:agentA' } },
    },
  });
});

test('a claim of this daemon whose session no longer resolves is not named', () => {
  const store = storeWithLeasedSession();

  const response = dropInvisibleClaimOwner(
    request({ leaseId: 'lease-a' }),
    store,
    claimConflictResponse('e2b:expired', store.resolveDaemonStateDir()),
  );

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.message).toBe('Device is already in use by another session.');
  expect(response.error.details?.owner).toBeUndefined();
});

test('a claim another daemon on this host wrote keeps its recorded owner', () => {
  const store = storeWithLeasedSession();
  const peerStateDir = mkdtempForTestSync('agent-device-reply-visibility-peer-');

  const response = dropInvisibleClaimOwner(
    request(),
    store,
    claimConflictResponse('default', path.join(peerStateDir, 'daemon')),
  );

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.message).toContain('default');
  expect(response.error.details?.owner).toMatchObject({ workspace: '/work/a' });
});

test('a refusal without a claim owner passes through', () => {
  const store = storeWithLeasedSession();
  const response: DaemonResponse = {
    ok: false,
    error: {
      code: 'DEVICE_IN_USE',
      message: 'Device is already in use by session "x".',
      details: { session: 'x' },
    },
  };

  expect(dropInvisibleClaimOwner(request(), store, response)).toBe(response);
});

// The naming rule: another proxy client's leased or tenant-scoped session is the only thing a
// local caller may not be told. A local session of another workspace keeps its address (#2580).
test('the naming rule hides only leased and tenant-scoped sessions', () => {
  const store = storeWithLeasedSession();
  const own = { session: 'e2b:agentA', workspace: '/w', stateDir: store.resolveDaemonStateDir() };

  expect(claimOwnerVisible(request(), store, own)).toBe(false);
  expect(claimOwnerVisible(request({ leaseId: 'lease-a' }), store, own)).toBe(true);
  expect(
    claimOwnerVisible(request({ leaseId: 'lease-a' }), store, { ...own, session: 'gone' }),
  ).toBe(false);
  expect(
    claimOwnerVisible(request(), store, { ...own, stateDir: path.join(own.stateDir, 'peer') }),
  ).toBe(true);

  const foreignWorkspaceSession = {
    name: 'default',
    sessionScope: { kind: 'cwd' as const, id: 'b'.repeat(16) },
    device: IOS_SIMULATOR,
    createdAt: 0,
    actions: [],
  };
  expect(mayNameSession(request(), foreignWorkspaceSession)).toBe(true);
  expect(mayNameSession(request(), store.get('e2b:agentA')!)).toBe(false);
});
