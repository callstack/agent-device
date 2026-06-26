import assert from 'node:assert/strict';
import { test } from 'vitest';
import { renderProxyStartup } from '../cli/commands/proxy.ts';

test('renderProxyStartup keeps human output concise', () => {
  const output = renderProxyStartup({
    proxyBaseUrl: 'http://127.0.0.1:4310',
    agentDeviceBaseUrl: 'http://127.0.0.1:4310/agent-device',
    token: 'proxy-secret',
    upstreamBaseUrl: 'http://127.0.0.1:60149',
    stateDir: '/private/tmp/agent-device-proxy',
  });

  assert.equal(
    output,
    [
      '✔️ Proxy listening at http://127.0.0.1:4310',
      '',
      'Provide this to the agent-device instance connecting:',
      '',
      'Daemon base URL: <tunnel URL>/agent-device',
      'Daemon auth token: proxy-secret',
    ].join('\n'),
  );
  assert.doesNotMatch(output, /upstream local daemon/);
  assert.doesNotMatch(output, /state dir/);
  assert.doesNotMatch(output, /Remote client example/);
  assert.doesNotMatch(output, /agent-device devices --daemon-base-url/);
});
