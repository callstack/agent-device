import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  buildDaemonHealthPayload,
  buildDaemonHttpAuthHeaders,
  buildDaemonHttpBaseUrl,
  buildDaemonHttpTenantHeaders,
  buildDaemonHttpUrl,
  DAEMON_RPC_PROTOCOL_VERSION,
} from './daemon-http.ts';

test('buildDaemonHttpBaseUrl appends the public agent-device base path', () => {
  assert.equal(
    buildDaemonHttpBaseUrl('https://example.trycloudflare.com'),
    'https://example.trycloudflare.com/agent-device',
  );
  assert.equal(
    buildDaemonHttpBaseUrl('http://127.0.0.1:4310/'),
    'http://127.0.0.1:4310/agent-device',
  );
});

test('buildDaemonHttpUrl preserves daemon base paths for remote routes', () => {
  assert.equal(
    buildDaemonHttpUrl('https://example.trycloudflare.com/agent-device', 'health'),
    'https://example.trycloudflare.com/agent-device/health',
  );
  assert.equal(
    buildDaemonHttpUrl('https://example.trycloudflare.com/agent-device/', '/rpc'),
    'https://example.trycloudflare.com/agent-device/rpc',
  );
});

test('buildDaemonHttpAuthHeaders writes both supported daemon auth headers', () => {
  assert.deepEqual(buildDaemonHttpAuthHeaders(' token-1 '), {
    authorization: 'Bearer token-1',
    'x-agent-device-token': 'token-1',
  });
  assert.deepEqual(buildDaemonHttpAuthHeaders(''), {});
});

test('buildDaemonHttpTenantHeaders omits blank tenant identities', () => {
  assert.deepEqual(buildDaemonHttpTenantHeaders(' tenant-a '), {
    'x-agent-device-tenant': 'tenant-a',
  });
  assert.deepEqual(buildDaemonHttpTenantHeaders(''), {});
});

test('buildDaemonHealthPayload takes the version from its caller and keeps the payload shape', () => {
  assert.deepEqual(buildDaemonHealthPayload('agent-device-daemon', '0.20.9'), {
    ok: true,
    service: 'agent-device-daemon',
    version: '0.20.9',
    rpcProtocolVersion: DAEMON_RPC_PROTOCOL_VERSION,
  });
  assert.deepEqual(
    buildDaemonHealthPayload('agent-device-proxy', '0.20.9', { upstream: { ok: true } }),
    {
      ok: true,
      service: 'agent-device-proxy',
      version: '0.20.9',
      rpcProtocolVersion: DAEMON_RPC_PROTOCOL_VERSION,
      upstream: { ok: true },
    },
  );
});
