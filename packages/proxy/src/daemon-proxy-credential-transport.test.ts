// The default upstream transport is judged by its URL once, at construction. A custom transport owns
// its route, so its URL is not judged.

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createDaemonProxy, type DaemonProxyOptions } from './daemon-proxy.ts';

let stderr = '';
beforeEach(() => {
  stderr = '';
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

const health = () => new Request('https://gateway.example.test/agent-device/health');

function proxyFor(upstreamBaseUrl: string, upstreamFetch?: DaemonProxyOptions['upstreamFetch']) {
  return createDaemonProxy({
    upstreamBaseUrl,
    upstreamToken: 'daemon-secret',
    clientToken: 'client-secret',
    upstreamFetch,
  });
}

test('construction warns about a plain http upstream off loopback, ahead of any send', async () => {
  const atSend: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    atSend.push(stderr);
    return Response.json({ ok: true });
  });

  const proxy = proxyFor('http://upstream.example.test:4310');
  await vi.waitFor(() => expect(stderr).toContain('http://upstream.example.test:4310'));
  expect(atSend).toEqual([]);

  await proxy.handle(health());
  expect(atSend).toEqual([stderr]);
  expect(stderr).toContain('Use https, a loopback upstream, or your own upstreamFetch.');
  expect(stderr).not.toMatch(/daemon-secret|AGENT_DEVICE_ALLOW_INSECURE_TRANSPORT/);
});

test.each([
  ['a custom transport', 'http://custom.example.test', true],
  ['a loopback upstream', 'http://127.0.0.1:4310', false],
])('%s is not warned about', async (_label, upstreamBaseUrl, custom) => {
  const answer = async () => Response.json({ ok: true });
  vi.spyOn(globalThis, 'fetch').mockImplementation(answer);
  const proxy = proxyFor(upstreamBaseUrl, custom ? answer : undefined);

  expect((await proxy.handle(health())).status).toBe(200);
  expect(stderr).toBe('');
});
