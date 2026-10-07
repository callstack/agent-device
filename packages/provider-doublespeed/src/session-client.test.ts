import { expect, test } from 'vitest';
import { createDoublespeedSessionClient } from './session-client.ts';
import { scriptedFetch } from './runtime.fixtures.ts';

const API_URL = 'https://worker.example/i/token-a';

test('maps the session inventory and state to camel-cased shapes', async () => {
  const { fetch, calls } = scriptedFetch([
    () => ({
      body: {
        apps: [
          { bundle_id: 'com.apple.Preferences', name: 'Settings', install_type: 'System' },
          { bundle_id: 'com.example.ios', name: null, install_type: 'User' },
        ],
      },
    }),
    () => ({ body: { bundle_id: 'com.example.ios', pid: 12 } }),
    () => ({ body: { bundle_id: null, pid: null } }),
    () => ({ body: { bundle_id: 'com.example.ios', text: 'line one\nline two\n' } }),
  ]);
  const client = createDoublespeedSessionClient(API_URL, { fetch });

  expect(await client.listApps()).toEqual([
    { bundleId: 'com.apple.Preferences', name: 'Settings', installType: 'System' },
    { bundleId: 'com.example.ios', installType: 'User' },
  ]);
  expect(await client.foregroundApp()).toEqual({ bundleId: 'com.example.ios' });
  expect(await client.foregroundApp()).toEqual({});
  expect(await client.appLogTail('com.example.ios', 200)).toBe('line one\nline two\n');
  expect(calls[3]?.url).toBe(`${API_URL}/logs?bundle_id=com.example.ios&lines=200`);
});

test('sends install, input and orientation requests in the session wire shape', async () => {
  const { fetch, calls } = scriptedFetch([
    () => ({ body: { bundle_id: 'com.example.ios', launched: true } }),
    () => ({ body: { ok: true } }),
    () => ({ body: { ok: true } }),
    () => ({ body: { ok: true } }),
    () => ({ body: { ok: true } }),
  ]);
  const client = createDoublespeedSessionClient(API_URL, { fetch });

  expect(
    await client.installApp({
      url: 'https://blob/get',
      sha256: 'abc',
      launchMode: 'RelaunchIfRunning',
    }),
  ).toEqual({ bundleId: 'com.example.ios' });
  await client.tapElement({ label: 'Continue' });
  await client.longPress(10, 20, 600);
  await client.scroll('down', 300);
  await client.setOrientation('landscape');

  expect(
    calls.map((call) => [call.url.slice(API_URL.length), JSON.parse(String(call.init.body))]),
  ).toEqual([
    ['/apps/install', { url: 'https://blob/get', sha256: 'abc', launch_mode: 'RelaunchIfRunning' }],
    ['/tap-element', { selector: { label: 'Continue' } }],
    ['/long-press', { x: 10, y: 20, ms: 600 }],
    ['/scroll', { direction: 'down', pixels: 300 }],
    ['/orientation', { orientation: 'landscape' }],
  ]);
});

test('keeps the typed provider reason for a missing element', async () => {
  const { fetch } = scriptedFetch([
    () => ({ status: 404, body: { error: { code: 'ELEMENT_NOT_FOUND', message: 'no element' } } }),
    () => ({ status: 500, body: { error: { code: 'INTERNAL', message: 'boom' } } }),
  ]);
  const client = createDoublespeedSessionClient(API_URL, { fetch });
  await expect(client.tapElement({ label: 'Nope' })).rejects.toMatchObject({
    code: 'ELEMENT_NOT_FOUND',
    details: { status: 404, providerCode: 'ELEMENT_NOT_FOUND' },
  });
  await expect(client.tap(1, 1)).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: { status: 500, providerCode: 'INTERNAL' },
  });
});
