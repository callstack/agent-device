import assert from 'node:assert/strict';
import { test } from 'vitest';
import { DAEMON_HTTP_PUBLIC_NETWORK_ACCESS } from '../http-contract.ts';
import type { DaemonRequest } from '../types.ts';
import { applyHttpTrustPolicy, resolveHttpTrustPolicy } from './http-trust-policy.ts';

test('an auth-hook HTTP server uses the public-only trust policy', () => {
  assert.deepEqual(resolveHttpTrustPolicy({ authHookConfigured: true }), {
    networkAccess: 'public-only',
  });
});

test('an HTTP server without an auth hook keeps local unrestricted behavior', () => {
  assert.deepEqual(resolveHttpTrustPolicy({ authHookConfigured: false }), {
    networkAccess: 'unrestricted',
  });
});

test('a proxy network marker selects public-only behavior without an auth hook', () => {
  assert.deepEqual(
    resolveHttpTrustPolicy({
      authHookConfigured: false,
      networkAccessMarker: DAEMON_HTTP_PUBLIC_NETWORK_ACCESS,
    }),
    { networkAccess: 'public-only' },
  );
});

test('an invalid or ambiguous proxy network marker fails closed', () => {
  for (const networkAccessMarker of ['unrestricted', ['public-only', 'public-only']]) {
    assert.throws(
      () => resolveHttpTrustPolicy({ authHookConfigured: false, networkAccessMarker }),
      /Invalid daemon HTTP network access marker/,
    );
  }
});

test('the public-only policy rejects every unbacked host path source', () => {
  assert.throws(
    () =>
      applyHttpTrustPolicy(
        requestWithMeta({ installSource: { kind: 'path', path: '/etc/passwd' } }),
        { networkAccess: 'public-only' },
      ),
    /path install sources are disabled on the remote HTTP surface/,
  );
});

test('the public-only policy preserves daemon-owned uploaded path sources', () => {
  const request = requestWithMeta({
    installSource: { kind: 'path', path: '/client/path.apk' },
    uploadedArtifactId: 'artifact-1',
  });

  assert.deepEqual(applyHttpTrustPolicy(request, { networkAccess: 'public-only' }), {
    ...request,
    internal: { networkAccess: 'public-only' },
  });
});

function requestWithMeta(meta: DaemonRequest['meta']): DaemonRequest {
  return {
    command: 'install_source',
    positionals: [],
    token: 'test-token',
    session: 'test-session',
    meta,
  };
}
