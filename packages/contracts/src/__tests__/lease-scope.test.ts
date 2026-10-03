import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  findMissingProxyLeaseFields,
  isInactiveLeaseError,
  leaseScopeFromOptions,
  leaseScopeFromRequest,
  leaseScopeToCommandFlags,
  leaseScopeToConnectionMetadata,
  leaseScopeToLeaseRpcParams,
  leaseScopeToRequestMeta,
  readLeaseAllocateProviderFlags,
} from '../lease-scope.ts';

test('leaseScopeFromOptions normalizes public aliases and projects request meta', () => {
  const scope = leaseScopeFromOptions({
    tenant: 'tenant-a',
    runId: 'run-1',
    leaseId: 'lease-1',
    ttlMs: 120_000,
    leaseBackend: 'ios-instance',
    provider: 'proxy',
    deviceKey: 'ios:SIM-001',
    clientId: 'client-a',
  });

  assert.deepEqual(scope, {
    tenantId: 'tenant-a',
    runId: 'run-1',
    leaseId: 'lease-1',
    leaseTtlMs: 120_000,
    leaseBackend: 'ios-instance',
    leaseProvider: 'proxy',
    deviceKey: 'ios:SIM-001',
    clientId: 'client-a',
  });
  assert.deepEqual(leaseScopeToRequestMeta(scope), {
    tenantId: 'tenant-a',
    runId: 'run-1',
    leaseId: 'lease-1',
    leaseTtlMs: 120_000,
    leaseBackend: 'ios-instance',
    leaseProvider: 'proxy',
    deviceKey: 'ios:SIM-001',
    clientId: 'client-a',
  });
  assert.deepEqual(leaseScopeToCommandFlags(scope), {
    tenant: 'tenant-a',
    runId: 'run-1',
    leaseId: 'lease-1',
    leaseBackend: 'ios-instance',
    leaseProvider: 'proxy',
    deviceKey: 'ios:SIM-001',
    clientId: 'client-a',
  });
});

test('leaseScopeFromRequest prefers metadata and falls back to legacy flags', () => {
  assert.deepEqual(
    leaseScopeFromRequest({
      meta: {
        tenantId: 'tenant-meta',
        leaseProvider: 'limrun',
      },
      flags: {
        tenant: 'tenant-flag',
        runId: 'run-flag',
        leaseId: 'lease-flag',
        provider: 'proxy',
        deviceKey: 'ios:SIM-001',
        clientId: 'client-a',
      },
    }),
    {
      tenantId: 'tenant-meta',
      runId: 'run-flag',
      leaseId: 'lease-flag',
      leaseProvider: 'limrun',
      deviceKey: 'ios:SIM-001',
      clientId: 'client-a',
    },
  );
});

test('leaseScopeToLeaseRpcParams projects canonical provider and command-specific fields', () => {
  const scope = leaseScopeFromOptions({
    tenant: 'tenant-a',
    runId: 'run-1',
    leaseId: 'lease-1',
    leaseTtlMs: 60_000,
    leaseBackend: 'android-instance',
    leaseProvider: 'proxy',
    deviceKey: 'android:emulator-5554',
    clientId: 'client-a',
  });

  assert.deepEqual(
    leaseScopeToLeaseRpcParams(scope, 'lease_allocate', {
      includeTokenParam: true,
      token: 'token',
      session: 'default',
    }),
    {
      token: 'token',
      session: 'default',
      tenantId: 'tenant-a',
      runId: 'run-1',
      leaseProvider: 'proxy',
      clientId: 'client-a',
      deviceKey: 'android:emulator-5554',
      ttlMs: 60_000,
      backend: 'android-instance',
    },
  );
  assert.deepEqual(
    leaseScopeToLeaseRpcParams(scope, 'lease_release', {
      includeTokenParam: false,
      token: 'token',
      session: 'default',
    }),
    {
      session: 'default',
      tenantId: 'tenant-a',
      runId: 'run-1',
      leaseProvider: 'proxy',
      clientId: 'client-a',
      deviceKey: 'android:emulator-5554',
      leaseId: 'lease-1',
    },
  );
});

test('leaseScopeToConnectionMetadata returns only connection lease fields', () => {
  assert.deepEqual(
    leaseScopeToConnectionMetadata(
      leaseScopeFromOptions({
        tenant: 'tenant-a',
        runId: 'run-1',
        leaseId: 'lease-1',
        leaseProvider: 'proxy',
        deviceKey: 'ios:SIM-001',
        clientId: 'client-a',
      }),
    ),
    {
      leaseProvider: 'proxy',
      deviceKey: 'ios:SIM-001',
      clientId: 'client-a',
    },
  );
  assert.equal(leaseScopeToConnectionMetadata({}), undefined);
});

test('findMissingProxyLeaseFields enforces complete proxy ownership scope', () => {
  assert.deepEqual(
    findMissingProxyLeaseFields({
      tenantId: 'tenant-a',
      runId: 'run-1',
      leaseProvider: 'proxy',
      clientId: 'client-a',
    }),
    ['leaseId', 'deviceKey'],
  );
  assert.deepEqual(
    findMissingProxyLeaseFields({
      leaseProvider: 'limrun',
    }),
    [],
  );
});

test('readLeaseAllocateProviderFlags carries the provider-allocation flags and drops the rest', () => {
  assert.deepEqual(
    readLeaseAllocateProviderFlags({
      session: 'default',
      token: 'secret',
      runId: 'run-a',
      deviceKey: 'dk-1',
      provider: 'browserstack',
      ttlMs: 1000,
      platform: 'ios',
      device: 'iPhone 15',
      providerApp: 'bs://abc',
      providerOsVersion: '17',
      providerProject: 'MyProject',
      providerBuild: 'Build-1',
      providerSessionName: 'smoke',
      providerDeviceOrientation: 'landscape',
      providerGeoLocation: '52.5,13.4',
      providerLanguage: 'en',
      providerNoResignApp: true,
      awsRegion: 'us-west-2',
      awsProjectArn: 'arn:aws:devicefarm:0',
      awsInteractionMode: 'NO_VIDEO',
    }),
    {
      platform: 'ios',
      device: 'iPhone 15',
      providerApp: 'bs://abc',
      providerOsVersion: '17',
      providerProject: 'MyProject',
      providerBuild: 'Build-1',
      providerSessionName: 'smoke',
      providerDeviceOrientation: 'landscape',
      providerGeoLocation: '52.5,13.4',
      providerLanguage: 'en',
      providerNoResignApp: true,
      awsRegion: 'us-west-2',
      awsProjectArn: 'arn:aws:devicefarm:0',
      awsInteractionMode: 'NO_VIDEO',
    },
  );
  assert.deepEqual(
    readLeaseAllocateProviderFlags({ providerApp: 'bs://abc', providerBuild: undefined }),
    { providerApp: 'bs://abc' },
  );
  assert.deepEqual(readLeaseAllocateProviderFlags(undefined), {});
});

test('isInactiveLeaseError recognizes the lease being gone, and refuses a request mismatch', () => {
  for (const reason of ['LEASE_NOT_FOUND', 'LEASE_EXPIRED', 'LEASE_REVOKED']) {
    assert.equal(
      isInactiveLeaseError({ code: 'UNAUTHORIZED', details: { reason } }),
      true,
      `${reason} says the lease is no longer usable`,
    );
  }
  // A mismatch is about the request that asked, not the lease: the lease may be perfectly alive and
  // held by this same client under another request, so a beat must keep renewing on this answer.
  assert.equal(
    isInactiveLeaseError({ code: 'UNAUTHORIZED', details: { reason: 'LEASE_SCOPE_MISMATCH' } }),
    false,
    'a scope mismatch is not the lease being gone',
  );
  // Both halves are required: the code alone is any unauthorized call, and the reason alone could
  // ride on an error the client has no business acting on.
  assert.equal(isInactiveLeaseError({ code: 'UNAUTHORIZED', details: {} }), false);
  assert.equal(
    isInactiveLeaseError({ code: 'COMMAND_FAILED', details: { reason: 'LEASE_NOT_FOUND' } }),
    false,
  );
  assert.equal(isInactiveLeaseError(new Error('LEASE_NOT_FOUND')), false);
  assert.equal(isInactiveLeaseError(undefined), false);
});
