import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempForTest } from '@agent-device/test-kit';
import {
  prepareLimrunRunnerProducts,
  uploadLimrunRunnerProducts,
} from './limrun-ios-runner-products.ts';

afterEach(() => vi.unstubAllGlobals());
const endpoint = { port: 8100, token: 'a'.repeat(32) };

test('a normal app without a test bundle reports the invalid runner path', async () => {
  const directory = await mkdtempForTest('runner-products-');
  const appPath = path.join(directory, 'Ordinary.app');
  await fs.mkdir(appPath);
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  await expect(
    prepareLimrunRunnerProducts({
      directory,
      appPath,
      version: '0.1.0',
      bindAddress: '10.244.1.2',
      endpoint,
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({
    code: 'INVALID_ARGS',
    message: 'The app does not contain AgentDeviceRunnerUITests.xctest',
  });
  expect(fetch).not.toHaveBeenCalled();
});

test('a runner that embeds its own XCTest is refused before it reaches Limrun', async () => {
  const directory = await mkdtempForTest('runner-products-');
  const appPath = path.join(directory, 'AgentDeviceRunnerUITests-Runner.app');
  // An Xcode 26 build: the runner app carries XCTest, which crashes under the host's Xcode 27.
  await fs.mkdir(path.join(appPath, 'PlugIns', 'AgentDeviceRunnerUITests.xctest'), {
    recursive: true,
  });
  await fs.mkdir(path.join(appPath, 'Frameworks', 'XCTest.framework'), { recursive: true });
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  await expect(
    prepareLimrunRunnerProducts({
      directory,
      appPath,
      version: '0.1.0',
      bindAddress: '10.244.1.2',
      endpoint,
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({
    code: 'INVALID_ARGS',
    message: 'The Limrun XCTest runner embeds XCTest.framework from an Xcode older than 27',
    details: { reason: 'limrun_runner_products_invalid' },
  });
  expect(fetch).not.toHaveBeenCalled();
});

test('an HTML upload failure preserves the HTTP status', async () => {
  const directory = await mkdtempForTest('runner-products-');
  await fs.writeFile(path.join(directory, 'Runner.xctestrun'), '<plist/>');
  vi.stubGlobal('fetch', async () => new Response('<html>Bad Gateway</html>', { status: 502 }));
  await expect(
    uploadLimrunRunnerProducts(
      directory,
      'https://instance.invalid',
      'token',
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: 'COMMAND_FAILED', details: { status: 502 } });
});

for (const bindAddress of ['0.0.0.0', 'localhost', '', '::1']) {
  test(`refuses ${JSON.stringify(bindAddress)} as a pod binding`, async () => {
    await expect(
      prepareLimrunRunnerProducts({
        directory: await mkdtempForTest('runner-products-'),
        version: '0.1.0',
        bindAddress,
        endpoint,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'COMMAND_FAILED' });
  });
}

test('refuses release bytes with a mismatched checksum before extracting or deploying them', async () => {
  const urls: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    urls.push(url);
    return new Response(
      url.endsWith('.json')
        ? JSON.stringify({
            version: '0.1.0',
            platform_target: 'iphonesimulator',
            sha256: '0'.repeat(64),
          })
        : 'untrusted archive',
    );
  });
  const directory = await mkdtempForTest('runner-products-');
  await expect(
    prepareLimrunRunnerProducts({
      directory,
      version: '0.1.0',
      bindAddress: '10.244.1.2',
      endpoint,
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow('iOS runner checksum mismatch');
  expect(urls).toEqual([
    'https://github.com/callstack/agent-device/releases/download/v0.1.0/agent-device-ios-runner-0.1.0.manifest.json',
    'https://github.com/callstack/agent-device/releases/download/v0.1.0/agent-device-ios-runner-0.1.0.app.tar.gz',
  ]);
  await expect(fs.stat(path.join(directory, 'extracted'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

test('nightly builds require a packaged runner instead of requesting unpublished release assets', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  await expect(
    prepareLimrunRunnerProducts({
      directory: await mkdtempForTest('runner-products-'),
      version: '0.1.0-nightly.20261030.123',
      bindAddress: '10.244.1.2',
      endpoint,
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({
    code: 'INVALID_ARGS',
    message: 'Nightly and development builds require AGENT_DEVICE_LIMRUN_IOS_RUNNER_APP',
  });
  expect(fetch).not.toHaveBeenCalled();
});

for (const recover of [true, false]) {
  test(`a missing remote products tree ${recover ? 'recovers with full payloads' : 'fails after one full retry'}`, async () => {
    const { createServer } = await import('node:http');
    const { gunzipSync } = await import('node:zlib');
    const directory = await mkdtempForTest('runner-products-');
    await fs.writeFile(path.join(directory, 'Runner.xctestrun'), '<plist/>');
    await fs.mkdir(path.join(directory, 'Runner.app'));
    await fs.writeFile(path.join(directory, 'Runner.app/Runner'), 'runner executable');
    const uploads: Array<{ payloads: Array<{ path: string; length: number }> }> = [];
    const bodies: Buffer[] = [];
    const server = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = gunzipSync(Buffer.concat(chunks));
      const size = body.readUInt32BE(0);
      uploads.push(JSON.parse(body.subarray(4, 4 + size).toString()));
      bodies.push(body.subarray(4 + size));
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify(
          recover && uploads.length === 2
            ? { ok: true }
            : { ok: false, needFull: ['Runner.app/Runner'] },
        ),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');
    try {
      const upload = uploadLimrunRunnerProducts(
        directory,
        `http://127.0.0.1:${address.port}`,
        'token',
        new AbortController().signal,
        ['Runner.xctestrun'],
      );
      if (recover) await upload;
      else
        await expect(upload).rejects.toMatchObject({
          code: 'COMMAND_FAILED',
          details: { needFull: ['Runner.app/Runner'] },
        });
      expect(uploads).toHaveLength(2);
      expect(uploads[0]!.payloads.map((file) => file.path)).toEqual(['Runner.xctestrun']);
      expect(uploads[1]!.payloads.map((file) => file.path).sort()).toEqual([
        'Runner.app/Runner',
        'Runner.xctestrun',
      ]);
      expect(bodies[1]!.toString()).toContain('runner executable');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}
