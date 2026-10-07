import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  buildDaemonHealthPayload,
  buildDaemonHttpAuthHeaders,
  buildDaemonHttpBaseUrl,
  buildDaemonHttpTenantHeaders,
  buildDaemonHttpUrl,
  buildRemoteTempArtifactDirPath,
  buildRemoteTempArtifactPath,
  DAEMON_RPC_PROTOCOL_VERSION,
  isRemoteTempArtifactPath,
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

test('the daemon recognizes every temp path a remote client names, however the extension is spelled', () => {
  for (const built of ['png', '.png']) {
    for (const checked of ['png', '.png']) {
      assert.equal(
        isRemoteTempArtifactPath(
          buildRemoteTempArtifactPath('screenshot', built),
          'screenshot',
          checked,
        ),
        true,
        `built with '${built}', checked with '${checked}'`,
      );
    }
  }
});

test('a temp path of another prefix, a directory, or an escape is not a remote temp artifact', () => {
  const screenshot = buildRemoteTempArtifactPath('screenshot', '.png');
  assert.equal(isRemoteTempArtifactPath(screenshot, 'recording', '.png'), false);
  assert.equal(
    isRemoteTempArtifactPath(buildRemoteTempArtifactDirPath('screenshot'), 'screenshot', '.png'),
    false,
  );
  assert.equal(isRemoteTempArtifactPath(`${screenshot}/../x.png`, 'screenshot', '.png'), false);
  assert.equal(
    isRemoteTempArtifactPath('/Users/me/agent-device-screenshot-1-a.png', 'screenshot', '.png'),
    false,
  );
});
