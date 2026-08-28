import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { DoublespeedApiClient } from './api-client.ts';
import { readySimulator, scriptedFetch } from './runtime.fixtures.ts';

function client(fetchImpl: typeof fetch, apiUrl?: string) {
  return new DoublespeedApiClient({
    apiKey: 'dsx_test_key',
    clientVersion: '1.2.3',
    fetch: fetchImpl,
    ...(apiUrl ? { apiUrl } : {}),
  });
}

test('creates a simulator, identifies the CLI, and polls until the session is ready', async () => {
  const { fetch, calls } = scriptedFetch([
    () => ({
      status: 202,
      body: readySimulator({ ready: false, status: 'queued', api_url: null }),
    }),
    () => ({ body: readySimulator({ ready: false, status: 'preparing', api_url: null }) }),
    () => ({ body: readySimulator() }),
  ]);

  const simulator = await client(fetch, 'https://api.example/').createSimulator({
    device: 'iPhone 16 Pro',
    labels: { leaseId: 'lease-a' },
    idleTimeoutSeconds: 600,
  });

  expect(simulator.ready).toBe(true);
  expect(simulator.api_url).toBe('https://worker.example/i/token-a');
  expect(calls.map((call) => `${call.init.method} ${call.url}`)).toEqual([
    'POST https://api.example/v1/xcode/simulators',
    'GET https://api.example/v1/xcode/simulators/sim-a?wait=1',
    'GET https://api.example/v1/xcode/simulators/sim-a?wait=1',
  ]);
  expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
    device: 'iPhone 16 Pro',
    labels: { leaseId: 'lease-a' },
    idle_timeout_seconds: 600,
    wait: true,
  });
  expect(calls[0]?.init.headers).toMatchObject({
    authorization: 'Bearer dsx_test_key',
    'x-agent-device-client': 'agent-device-cli',
    'x-agent-device-version': '1.2.3',
  });
});

test('fails closed when the simulator job ends before it is ready', async () => {
  const { fetch } = scriptedFetch([
    () => ({
      status: 202,
      body: readySimulator({
        ready: false,
        status: 'failed',
        api_url: null,
        error: { code: 'PREVIEW_SETUP', message: 'no simulator named "iPhone 3"' },
      }),
    }),
  ]);
  await expect(client(fetch).createSimulator({ labels: {} })).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: { status: 'failed', providerError: { code: 'PREVIEW_SETUP' } },
  });
});

test('classifies authentication and credit failures without echoing the key', async () => {
  const unauthorized = scriptedFetch([
    () => ({ status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'bad key' } } }),
  ]);
  await expect(client(unauthorized.fetch).listSimulators({})).rejects.toSatisfy(
    (error: unknown) => {
      expect(error).toMatchObject({ code: 'UNAUTHORIZED' });
      expect(JSON.stringify(error)).not.toContain('dsx_test_key');
      return true;
    },
  );
  const credits = scriptedFetch([
    () => ({
      status: 402,
      body: { error: { code: 'INSUFFICIENT_CREDITS', message: 'no credits' } },
    }),
  ]);
  await expect(client(credits.fetch).createSimulator({ labels: {} })).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: { status: 402, providerCode: 'INSUFFICIENT_CREDITS' },
  });
});

test('lists simulators by label selector and deletes by id', async () => {
  const { fetch, calls } = scriptedFetch([
    () => ({ body: { simulators: [readySimulator()] } }),
    () => ({ body: readySimulator({ status: 'cancelled', ready: false }) }),
  ]);
  const api = client(fetch);
  const simulators = await api.listSimulators({ provider: 'doublespeed', leaseId: 'lease-a' });
  await api.deleteSimulator('sim-a');
  expect(simulators.map((simulator) => simulator.id)).toEqual(['sim-a']);
  expect(calls[0]?.url).toBe(
    'https://api.mac.doublespeed.ai/v1/xcode/simulators?label_selector=provider%3Ddoublespeed%2CleaseId%3Dlease-a',
  );
  expect(`${calls[1]?.init.method} ${calls[1]?.url}`).toBe(
    'DELETE https://api.mac.doublespeed.ai/v1/xcode/simulators/sim-a',
  );
});

test('registers, uploads and completes an asset with the signed URL as the only capability', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doublespeed-asset-'));
  const filePath = path.join(tempDir, 'app.zip');
  fs.writeFileSync(filePath, 'zip-bytes');
  const { fetch, calls } = scriptedFetch([
    () => ({
      body: {
        sha256: 'abc',
        exists: false,
        upload_url: 'https://blob.example/upload?token=x',
        download_url: null,
      },
    }),
    () => ({ body: {} }),
    () => ({
      body: {
        sha256: 'abc',
        exists: true,
        upload_url: null,
        download_url: 'https://blob.example/get',
      },
    }),
  ]);
  const api = client(fetch);
  const registered = await api.registerAsset({ sha256: 'abc', size: 9, name: 'app.zip' });
  await api.uploadAsset(registered.upload_url!, filePath);
  const completed = await api.completeAsset('abc', 9);

  expect(completed.download_url).toBe('https://blob.example/get');
  expect(`${calls[1]?.init.method} ${calls[1]?.url}`).toBe(
    'PUT https://blob.example/upload?token=x',
  );
  expect(calls[1]?.init.headers).not.toHaveProperty('authorization');
  expect(String(calls[1]?.init.body)).toBe('zip-bytes');
  expect(calls[2]?.url).toBe('https://api.mac.doublespeed.ai/v1/xcode/assets/abc/complete');
  fs.rmSync(tempDir, { recursive: true, force: true });
});
