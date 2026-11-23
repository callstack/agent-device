import path from 'node:path';
import { expect, test } from 'vitest';
import { IOS_SIMULATOR, mkdtempForTestSync } from '@agent-device/test-kit';
import { makeSessionStore } from '../../__tests__/support/store-factory.ts';
import { makeIosAppSession } from '../../__tests__/support/session-factories.ts';
import type { DaemonRequest } from '../../core/daemon-request.ts';
import { SessionStore } from '../../core/session-store.ts';
import { claimOwnerVisible, createSessionVisibilityPredicate } from '../session-routing.ts';
import { buildDeviceClaimConflictError } from '../../resources/device/device-claim-conflict.ts';
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

const LOCAL_REQUEST = request({ tenantId: undefined, sessionIsolation: undefined });

function storeWithLeasedSession(): SessionStore {
  const store = makeSessionStore('agent-device-reply-visibility-');
  store.publish(
    'e2b:agentA',
    makeIosAppSession('e2b:agentA', {
      sessionScope: { kind: 'tenant', id: TENANT },
      lease: {
        leaseId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        tenantId: TENANT,
        runId: 'run-a',
        backend: 'ios-simulator',
      },
    }),
  );
  return store;
}

function claimConflictResponse(
  req: DaemonRequest,
  store: SessionStore,
  session: string,
  stateDir = store.resolveDaemonStateDir(),
): DaemonResponse {
  const deviceKey = 'local:apple:ios:sim-1';
  return buildDeviceClaimConflictError(
    IOS_SIMULATOR,
    {
      fileName: 'claim.json',
      classification: 'live',
      deviceKey,
      claim: {
        schemaVersion: 3,
        claimOwnerKind: 'open-session',
        deviceKey,
        device: {
          family: 'apple',
          appleOs: 'ios',
          id: IOS_SIMULATOR.id,
          name: IOS_SIMULATOR.name,
          kind: 'simulator',
        },
        session,
        workspace: '/work/a',
        stateDir,
        ownerPid: 4242,
        ownerStartTime: 'start',
        ownerToken: 'token',
        createdAtMs: 1,
        updatedAtMs: 1,
      },
    },
    (owner) => claimOwnerVisible(req, store, owner),
  );
}

test('a claim naming an invisible leased session loses its owner', () => {
  const store = storeWithLeasedSession();

  const response = claimConflictResponse(request(), store, 'e2b:agentA');

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

  const response = claimConflictResponse(
    request({ leaseId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }),
    store,
    'e2b:agentA',
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

  const response = claimConflictResponse(
    request({ leaseId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }),
    store,
    'e2b:expired',
  );

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.message).toBe('Device is already in use by another session.');
  expect(response.error.details?.owner).toBeUndefined();
});

test('a local request keeps the owner of a transient claim of this daemon', () => {
  const store = storeWithLeasedSession();

  const response = claimConflictResponse(LOCAL_REQUEST, store, 'transient:install');

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.details?.owner).toMatchObject({ session: 'transient:install' });
});

test('a claim another daemon on this host wrote keeps its owner for a local request only', () => {
  const store = storeWithLeasedSession();
  const peerStateDir = mkdtempForTestSync('agent-device-reply-visibility-peer-');
  const stateDir = path.join(peerStateDir, 'daemon');

  const local = claimConflictResponse(LOCAL_REQUEST, store, 'default', stateDir);
  expect(local.ok).toBe(false);
  if (local.ok) return;
  expect(local.error.message).toContain('default');
  expect(local.error.details?.owner).toMatchObject({ workspace: '/work/a' });

  const proxied = claimConflictResponse(request(), store, 'default', stateDir);
  expect(proxied.ok).toBe(false);
  if (proxied.ok) return;
  expect(proxied.error.details?.owner).toBeUndefined();
});

test('only local device recovery names an unlistable local session', () => {
  const store = storeWithLeasedSession();
  const own = { session: 'e2b:agentA', workspace: '/w', stateDir: store.resolveDaemonStateDir() };

  expect(claimOwnerVisible(request(), store, own)).toBe(false);
  expect(
    claimOwnerVisible(request({ leaseId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }), store, own),
  ).toBe(true);
  expect(
    claimOwnerVisible(request({ leaseId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }), store, {
      ...own,
      session: 'gone',
    }),
  ).toBe(false);
  const peerClaim = { ...own, stateDir: path.join(own.stateDir, 'peer') };
  expect(claimOwnerVisible(request(), store, peerClaim)).toBe(false);
  expect(claimOwnerVisible(LOCAL_REQUEST, store, peerClaim)).toBe(true);

  const foreignWorkspaceSession = {
    name: 'default',
    sessionScope: { kind: 'cwd' as const, id: 'b'.repeat(16) },
    device: IOS_SIMULATOR,
    createdAt: 0,
    actions: [],
  };
  const cwdRequest = {
    ...request({
      cwd: mkdtempForTestSync('agent-device-reply-visibility-cwd-'),
      tenantId: undefined,
      sessionIsolation: undefined,
    }),
    session: 'default',
  };
  expect(
    createSessionVisibilityPredicate(request(), 'device-recovery')(foreignWorkspaceSession),
  ).toBe(false);
  expect(createSessionVisibilityPredicate(cwdRequest)(foreignWorkspaceSession)).toBe(false);
  expect(
    createSessionVisibilityPredicate(cwdRequest, 'device-recovery')(foreignWorkspaceSession),
  ).toBe(true);
  expect(createSessionVisibilityPredicate(LOCAL_REQUEST)(foreignWorkspaceSession)).toBe(true);
  expect(
    createSessionVisibilityPredicate({ ...LOCAL_REQUEST, internal: { publicNetworkOnly: true } })(
      foreignWorkspaceSession,
    ),
  ).toBe(false);
  expect(createSessionVisibilityPredicate(request())(store.get('e2b:agentA')!)).toBe(false);
});
