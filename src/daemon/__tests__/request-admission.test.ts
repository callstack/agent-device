import { test } from 'vitest';
import assert from 'node:assert/strict';
import { makeIosSession } from '../../__tests__/test-utils/session-factories.ts';
import { LeaseRegistry } from '../lease-registry.ts';
import { assertRequestLeaseAdmission } from '../request-admission.ts';
import type { DaemonRequest } from '../daemon-request.ts';
import type { ProviderAppCatalog } from '@agent-device/contracts/device';

const limrunAppCatalog: ProviderAppCatalog = {
  supports: (provider) => provider === 'limrun',
  list: async () => [],
};

function makeRequest(overrides: Partial<DaemonRequest> = {}): DaemonRequest {
  return {
    token: 'token',
    session: 'default',
    command: 'close',
    positionals: [],
    flags: {},
    ...overrides,
  };
}

// #2016: a tenant-isolated connection (e.g. BrowserStack) whose lease was
// never allocated (`open` was never called) must not surface the generic
// tenant/run/lease admission error when `close` tries to clean it up.
test('close on a tenant-isolated session with no lease ever allocated admits without throwing', () => {
  const registry = new LeaseRegistry();

  const result = assertRequestLeaseAdmission(
    makeRequest({
      command: 'close',
      meta: { tenantId: 'tenant-a', runId: 'run-1', sessionIsolation: 'tenant' },
    }),
    registry,
    undefined,
  );

  assert.equal(result, undefined);
});

test('close on a lease-less but stored tenant-isolated session still requires a lease id', () => {
  // #2016 follow-up: a *stored* session under tenant isolation is keyed by
  // tenant, not by run, so a lease-less stored session could belong to
  // another run in the same tenant. The bypass must not treat "this session
  // record has no lease field" as proof there's nothing to protect — only
  // "no session record exists at all" (the actual deferred-connect case)
  // qualifies.
  const registry = new LeaseRegistry();
  const session = makeIosSession('default');

  assert.throws(
    () =>
      assertRequestLeaseAdmission(
        makeRequest({
          command: 'close',
          meta: { tenantId: 'tenant-a', runId: 'run-1', sessionIsolation: 'tenant' },
        }),
        registry,
        session,
      ),
    /tenant isolation requires lease id/,
  );
});

test('close with an app target still requires a lease id even with no lease anywhere', () => {
  // #2016 follow-up: `close <app>` with no session resolves its device
  // straight from flags (`closeWithoutSession`), so it must not bypass
  // tenant/lease admission the way a plain `close` (nothing to close) does —
  // otherwise any caller could close an arbitrary flag-selected device on a
  // tenant-isolated fleet without ever presenting a lease.
  const registry = new LeaseRegistry();

  assert.throws(
    () =>
      assertRequestLeaseAdmission(
        makeRequest({
          command: 'close',
          positionals: ['com.example.app'],
          meta: { tenantId: 'tenant-a', runId: 'run-1', sessionIsolation: 'tenant' },
        }),
        registry,
        undefined,
      ),
    /tenant isolation requires lease id/,
  );
});

test('close with an explicit lease id but no session lease still requires an active lease', () => {
  const registry = new LeaseRegistry();

  assert.throws(
    () =>
      assertRequestLeaseAdmission(
        makeRequest({
          command: 'close',
          meta: {
            tenantId: 'tenant-a',
            runId: 'run-1',
            leaseId: 'a'.repeat(32),
            sessionIsolation: 'tenant',
          },
        }),
        registry,
        undefined,
      ),
    /Lease is not active/,
  );
});

test('non-close commands on a tenant-isolated session still require a lease id', () => {
  const registry = new LeaseRegistry();

  assert.throws(
    () =>
      assertRequestLeaseAdmission(
        makeRequest({
          command: 'snapshot',
          meta: { tenantId: 'tenant-a', runId: 'run-1', sessionIsolation: 'tenant' },
        }),
        registry,
        undefined,
      ),
    /tenant isolation requires lease id/,
  );
});

test.each(['bogus', 'proxy', 'browserstack'])(
  'sessionless apps for non-catalog provider %s still requires a tenant lease',
  (leaseProvider) => {
    const registry = new LeaseRegistry();

    assert.throws(
      () =>
        assertRequestLeaseAdmission(
          makeRequest({
            command: 'apps',
            flags: { platform: 'ios', leaseProvider },
            meta: { tenantId: 'tenant-a', runId: 'run-1', sessionIsolation: 'tenant' },
          }),
          registry,
          undefined,
        ),
      /tenant isolation requires lease id/,
    );
  },
);

test('sessionless apps admits a provider declared by the runtime app catalog', () => {
  const registry = new LeaseRegistry();

  const result = assertRequestLeaseAdmission(
    makeRequest({
      command: 'apps',
      flags: { platform: 'ios', leaseProvider: 'limrun' },
      meta: { tenantId: 'tenant-a', runId: 'run-1', sessionIsolation: 'tenant' },
    }),
    registry,
    undefined,
    { providerAppCatalog: limrunAppCatalog },
  );

  assert.equal(result, undefined);
});

// #2946 (the other half): a proxy client that allocated a lease with a window longer than the old
// synthetic admission default used to lose that window on the next admitted command — admission
// re-renewed every proxy lease at its own default instead of the window the lease carries. Admission
// now renews for the lease's window (ADR 0007); only a request that names a window changes it.
test('admitting a command does not shorten a proxy lease allocated above the old admission default', () => {
  let now = 1_000;
  const registry = new LeaseRegistry({ now: () => now });
  const lease = registry.allocateLease({
    tenantId: 'tenant-a',
    runId: 'run-1',
    leaseProvider: 'proxy',
    deviceKey: 'ios:mobile:SIM-001',
    clientId: 'client-a',
    ttlMs: 600_000,
  });
  now = 2_000;

  const result = assertRequestLeaseAdmission(
    makeRequest({
      command: 'snapshot',
      meta: {
        tenantId: 'tenant-a',
        runId: 'run-1',
        sessionIsolation: 'tenant',
        leaseId: lease.leaseId,
        leaseProvider: 'proxy',
        deviceKey: 'ios:mobile:SIM-001',
        clientId: 'client-a',
      },
    }),
    registry,
    undefined,
  );

  assert.equal(result?.leaseId, lease.leaseId);
  // Without this, a lease handed back untouched would pass: allocation already leaves a 600_000
  // difference between these two stamps, so the delta alone cannot prove admission renewed anything.
  assert.equal(result!.heartbeatAt, 2_000, 'admission renewed at admission time');
  assert.equal(
    result!.expiresAt - result!.heartbeatAt,
    600_000,
    'the window the lease carries, not a smaller default',
  );
});

test('a command that names its own window renews the lease onto it', () => {
  let now = 1_000;
  const registry = new LeaseRegistry({ now: () => now });
  const lease = registry.allocateLease({
    tenantId: 'tenant-a',
    runId: 'run-1',
    leaseProvider: 'proxy',
    deviceKey: 'ios:mobile:SIM-001',
    clientId: 'client-a',
    ttlMs: 600_000,
  });
  now = 2_000;

  const result = assertRequestLeaseAdmission(
    makeRequest({
      command: 'snapshot',
      meta: {
        tenantId: 'tenant-a',
        runId: 'run-1',
        sessionIsolation: 'tenant',
        leaseId: lease.leaseId,
        leaseProvider: 'proxy',
        deviceKey: 'ios:mobile:SIM-001',
        clientId: 'client-a',
        leaseTtlMs: 90_000,
      },
    }),
    registry,
    undefined,
  );

  assert.equal(result!.expiresAt - result!.heartbeatAt, 90_000);
});

test('close still admits and heartbeats a real active lease', () => {
  let now = 1_000;
  const registry = new LeaseRegistry({ now: () => now });
  const lease = registry.allocateLease({ tenantId: 'tenant-a', runId: 'run-1' });
  const session = makeIosSession('default', {
    lease: {
      leaseId: lease.leaseId,
      tenantId: lease.tenantId,
      runId: lease.runId,
      leaseBackend: lease.backend,
      expiresAt: lease.expiresAt,
    },
  });
  now = 2_000;

  const result = assertRequestLeaseAdmission(
    makeRequest({
      command: 'close',
      meta: { tenantId: 'tenant-a', runId: 'run-1', sessionIsolation: 'tenant' },
    }),
    registry,
    session,
  );

  assert.equal(result?.leaseId, lease.leaseId);
  assert.equal(result?.heartbeatAt, 2_000);
});
