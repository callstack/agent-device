import assert from 'node:assert/strict';
import { test } from 'vitest';
import { findProxyStartup, type ProxyStartup } from './proxy-startup.ts';

const startup: ProxyStartup = {
  proxyBaseUrl: 'http://127.0.0.1:49152',
  agentDeviceBaseUrl: 'http://127.0.0.1:49152/agent-device',
  token: 'benchmark-token',
  stateDir: '/tmp/agent-device-benchmark/proxy',
};

test('findProxyStartup accepts the CLI pretty JSON envelope', () => {
  assert.deepEqual(
    findProxyStartup(JSON.stringify({ success: true, data: startup }, null, 2)),
    startup,
  );
});

test('findProxyStartup accepts a complete line-delimited envelope', () => {
  assert.deepEqual(
    findProxyStartup(`noise\n${JSON.stringify({ success: true, data: startup })}`),
    startup,
  );
});

test('findProxyStartup ignores incomplete or unrelated output', () => {
  assert.equal(findProxyStartup('{"success":true'), undefined);
  assert.equal(
    findProxyStartup(JSON.stringify({ success: true, data: { token: startup.token } })),
    undefined,
  );
});
