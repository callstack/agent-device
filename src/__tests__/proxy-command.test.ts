import assert from 'node:assert/strict';
import { test } from 'vitest';
import { renderProxyStartup } from '../cli/commands/proxy.ts';
import { colorize } from '../utils/output.ts';

const STARTUP = {
  proxyBaseUrl: 'http://127.0.0.1:4310',
  agentDeviceBaseUrl: 'http://127.0.0.1:4310/agent-device',
  token: 'proxy-secret',
  upstreamBaseUrl: 'http://127.0.0.1:60149',
  stateDir: '/private/tmp/agent-device-proxy',
};

test('renderProxyStartup keeps human output concise without color', () => {
  const output = renderProxyStartup(STARTUP, { useColor: false });

  assert.equal(
    output,
    [
      '✓ Proxy listening at http://127.0.0.1:4310',
      '',
      'Provide this to the agent-device instance connecting:',
      '',
      'Daemon base URL: <tunnel URL>',
      'Daemon auth token: proxy-secret',
    ].join('\n'),
  );
  assert.doesNotMatch(output, /upstream local daemon/);
  assert.doesNotMatch(output, /state dir/);
  assert.doesNotMatch(output, /Remote client example/);
  assert.doesNotMatch(output, /agent-device devices --daemon-base-url/);
});

test('renderProxyStartup colors status, urls, and token', () => {
  const output = renderProxyStartup(STARTUP, { useColor: true });

  assert.equal(
    output,
    [
      `${colored('✓', 'green')} Proxy listening at ${colored('http://127.0.0.1:4310', 'cyan')}`,
      '',
      'Provide this to the agent-device instance connecting:',
      '',
      `Daemon base URL: ${colored('<tunnel URL>', 'cyan')}`,
      `Daemon auth token: ${colored('proxy-secret', 'yellow')}`,
    ].join('\n'),
  );
});

function colored(text: string, format: Parameters<typeof colorize>[1]): string {
  return colorize(text, format, { validateStream: false });
}
