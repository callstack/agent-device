import { afterEach, beforeEach, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import type { NetworkIncludeMode } from '@agent-device/kernel/contracts';
import { dumpReactNativeAppNetwork } from './network-capture-dump.ts';
import { fakeMetroDevServer, type FakeMetroDevServer } from './network-capture-dump.fixtures.ts';

let stateDir: string;
let server: FakeMetroDevServer;

beforeEach(async () => {
  stateDir = mkdtempForTestSync('rn-network-capture-');
  server = await fakeMetroDevServer();
  writeMetroHints(stateDir, 'repro', server.serverUrl);
});

afterEach(async () => {
  await server.close();
});

function writeMetroHints(root: string, session: string, controlBaseUrl: string): void {
  const dir = path.join(root, 'metro-sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${session}.json`),
    `${JSON.stringify({ controlBaseUrl }, null, 2)}\n`,
    'utf8',
  );
}

function dump(overrides: Partial<{ include: NetworkIncludeMode; maxEntries: number }> = {}) {
  return dumpReactNativeAppNetwork({
    stateDir,
    session: 'repro',
    appBundleId: 'com.example.app',
    maxEntries: 25,
    include: 'summary',
    maxPayloadChars: 2048,
    // What the platform layer contributes for a host with one attached device of this name.
    metroDeviceIdentity: 'Fake Device 1',
    ...overrides,
  });
}

test('the first dump installs the capture and reports it armed with no traffic of its own', async () => {
  const result = await dump();

  expect(result).toMatchObject({
    backend: 'react-native-app',
    entries: [],
    armed: true,
  });
  expect(result.notes?.[0]).toContain('installed by this dump');
});

test('a later dump returns the method, full URL, status, and duration the app runtime performed', async () => {
  await dump();
  await server.app.request('https://api.example.test/v1/checkout?cart=42', {
    status: 201,
    body: '{"orderId":"o-1"}',
    responseHeaders: { 'content-type': 'application/json' },
  });

  const result = await dump({ include: 'body' });

  expect(result.armed).toBeUndefined();
  expect(result.entries).toHaveLength(1);
  expect(result.entries[0]).toMatchObject({
    method: 'GET',
    url: 'https://api.example.test/v1/checkout?cart=42',
    status: 201,
    responseBody: '{"orderId":"o-1"}',
  });
  expect(typeof result.entries[0]?.durationMs).toBe('number');
  expect(typeof result.entries[0]?.timestamp).toBe('string');
});

test('a drained entry is never returned by a second dump', async () => {
  await dump();
  await server.app.request('https://api.example.test/once', { status: 200, body: 'a' });
  expect((await dump()).entries).toHaveLength(1);

  const again = await dump();

  expect(again.entries).toEqual([]);
  expect(again.notes?.[0]).toContain('captured no request since the last dump');
});

test.each([
  ['summary', { requestHeaders: undefined, responseBody: undefined }],
  [
    'headers',
    {
      requestHeaders: { 'content-type': 'application/json', 'x-trace': 't-1' },
      responseBody: undefined,
    },
  ],
  ['body', { requestHeaders: undefined, responseBody: '{"hits":2}' }],
] as const)('include %s projects exactly the detail it names', async (include, expected) => {
  await dump();
  await server.app.request(
    'https://api.example.test/search',
    { status: 200, body: '{"hits":2}', responseHeaders: { 'content-type': 'application/json' } },
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-trace': 't-1' },
      body: '{"q":"shoes"}',
    },
  );

  const entry = (await dump({ include })).entries[0];

  expect(entry).toMatchObject({ method: 'POST', url: 'https://api.example.test/search' });
  expect(entry?.requestHeaders).toEqual(expected.requestHeaders);
  expect(entry?.responseBody).toBe(expected.responseBody);
  if (include === 'body') expect(entry?.requestBody).toBe('{"q":"shoes"}');
  else expect(entry?.requestBody).toBeUndefined();
});

test('a sensitive header value is redacted and a body secret is masked', async () => {
  await dump();
  await server.app.request(
    'https://api.example.test/account',
    {
      status: 200,
      body: '{"token":"abc.def.ghi"}',
      responseHeaders: { 'content-type': 'application/json' },
    },
    {
      method: 'POST',
      headers: { authorization: 'Bearer super-secret' },
      body: '{"apiKey":"sk-live-1"}',
    },
  );

  const result = await dump({ include: 'all' });

  expect(result.entries[0]?.requestHeaders).toMatchObject({ authorization: '[REDACTED]' });
  expect(result.entries[0]?.requestBody).toBe('{"apiKey":"[REDACTED]"}');
  expect(result.entries[0]?.responseBody).toBe('{"token":"[REDACTED]"}');
});

test('a failed request is reported with its error instead of a status', async () => {
  await dump();
  await server.app.request('https://api.example.test/down', { reject: 'Network request failed' });

  const result = await dump();

  expect(result.entries[0]).toMatchObject({
    url: 'https://api.example.test/down',
    metadata: { error: 'Network request failed', transport: 'fetch' },
  });
  expect(result.entries[0]?.status).toBeUndefined();
});

test('a failed fetch releases its claim so a later XHR to the same URL still records', async () => {
  await dump();
  await server.app.request('https://api.example.test/down', { reject: 'Network request failed' });
  await server.app.xhrRequest('https://api.example.test/down');

  const result = await dump({ include: 'summary' });

  const transports = result.entries.map((entry) => entry.metadata?.transport);
  expect(transports).toEqual(['xhr', 'fetch']);
  const xhrEntry = result.entries.find((entry) => entry.metadata?.transport === 'xhr');
  expect(xhrEntry?.url).toBe('https://api.example.test/down');
});

test('a fetch polyfilled on XMLHttpRequest records exactly one entry per request', async () => {
  await dump();
  await server.app.request('https://api.example.test/json', { status: 200, body: '{}' });

  const result = await dump();

  expect(result.entries).toHaveLength(1);
  expect(result.entries[0]?.metadata?.transport).toBe('fetch');
});

test('an XHR the app performs directly records with its own transport', async () => {
  await dump();
  await server.app.xhrRequest('https://api.example.test/poll');

  const result = await dump();

  expect(result.entries).toHaveLength(1);
  expect(result.entries[0]).toMatchObject({
    method: 'GET',
    url: 'https://api.example.test/poll',
    status: 200,
  });
  expect(result.entries[0]?.metadata?.transport).toBe('xhr');
});

test('a second connected device fails closed instead of guessing a runtime', async () => {
  await server.close();
  server = await fakeMetroDevServer({ devices: 2 });
  writeMetroHints(stateDir, 'repro', server.serverUrl);

  // No identity the session could name: the provider fails closed before reaching the listing.
  await expect(
    dumpReactNativeAppNetwork({
      stateDir,
      session: 'repro',
      appBundleId: 'com.example.app',
      maxEntries: 25,
      include: 'summary',
      maxPayloadChars: 2048,
    }),
  ).rejects.toMatchObject({ details: { reason: 'metro-device-mismatch' } });
});

test('a session device no runtime reports fails closed instead of hooking another device', async () => {
  // The fake server's runtimes name `Fake Device 1/2`; this session's device answers to neither,
  // so the provider must refuse to inject anywhere rather than read a stranger's traffic.
  await expect(
    dumpReactNativeAppNetwork({
      stateDir,
      session: 'repro',
      appBundleId: 'com.example.app',
      maxEntries: 25,
      include: 'summary',
      maxPayloadChars: 2048,
      metroDeviceIdentity: 'rn-net ios',
    }),
  ).rejects.toMatchObject({
    details: { reason: 'metro-device-mismatch' },
  });
});

test('only the runtime reporting the session identity is hooked, never the other device', async () => {
  await server.close();
  server = await fakeMetroDevServer({ devices: 2 });
  writeMetroHints(stateDir, 'repro', server.serverUrl);
  const result = await dumpReactNativeAppNetwork({
    stateDir,
    session: 'repro',
    appBundleId: 'com.example.app',
    maxEntries: 25,
    include: 'summary',
    maxPayloadChars: 2048,
    metroDeviceIdentity: 'Fake Device 2',
  });
  expect(result.armed).toBe(true);
  expect(server.hookedPages).toEqual(['device-2-1']);
});

test('an app-backed session whose device cannot be named fails closed without listing runtimes', async () => {
  await expect(
    dumpReactNativeAppNetwork({
      stateDir,
      session: 'repro',
      appBundleId: 'com.example.app',
      maxEntries: 25,
      include: 'summary',
      maxPayloadChars: 2048,
    }),
  ).rejects.toMatchObject({ details: { reason: 'metro-device-mismatch' } });
  expect(server.hookedPages).toEqual([]);
});

test('a session without a Metro binding or an unreachable dev server fails with a typed reason', async () => {
  await expect(
    dumpReactNativeAppNetwork({
      stateDir,
      session: 'no-metro',
      maxEntries: 25,
      include: 'summary',
      maxPayloadChars: 2048,
    }),
  ).rejects.toThrow(/no React Native dev-server binding/);

  await server.close();
  server = await fakeMetroDevServer();
  writeMetroHints(stateDir, 'repro', 'http://127.0.0.1:1/');
  await expect(dump()).rejects.toMatchObject({
    details: { reason: 'metro-server-unreachable' },
  });
});
