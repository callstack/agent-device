import { createServer } from 'node:https';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { mkdtempForTest } from '@agent-device/test-kit';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { WebSocketServer, type ClientOptions } from 'ws';
import { connectAdb } from './tunnel.ts';

function tlsFixture(name: string) {
  return new URL(`../../../test/integration/provider-scenarios/fixtures/${name}`, import.meta.url);
}

vi.mock('ws', async (importOriginal) => {
  const ws = await importOriginal<typeof import('ws')>();
  const ca = await readFile(tlsFixture('localhost-cert.pem'));
  return {
    ...ws,
    default: class extends ws.WebSocket {
      constructor(url: URL, options: ClientOptions) {
        super(url, { ...options, ca });
      }
    },
  };
});

it.skipIf(process.platform === 'win32')(
  'relays bytes through a private socket and reaps its ADB server on disconnect',
  async () => {
    const sdk = await mkdtempForTest('adc-sdk-');
    const platformTools = path.join(sdk, 'platform-tools');
    await mkdir(platformTools);
    const adb = path.join(platformTools, 'adb');
    // Exercise the real child lifecycle with the two adb responses needed for readiness.
    const executable = [
      '#!/usr/bin/env node',
      "const net = require('node:net');",
      'const args = process.argv.slice(2);',
      "if (args.includes('nodaemon')) net.createServer().listen(args[1].slice('localfilesystem:'.length));",
      "if (args.includes('get-state')) process.stdout.write('device');",
    ].join('\n');
    await writeFile(adb, executable, { mode: 0o700 });

    const cert = await readFile(tlsFixture('localhost-cert.pem'));
    const key = await readFile(tlsFixture('localhost-key.pem'));
    const tls = createServer({ cert, key });
    const vendor = new WebSocketServer({ server: tls });
    tls.listen(0, '127.0.0.1');
    let tunnel: Awaited<ReturnType<typeof connectAdb>> | undefined;
    try {
      await once(vendor, 'listening');
      const address = vendor.address();
      if (!address || typeof address === 'string') throw new Error('Expected a TCP port');
      const url = new URL(`wss://127.0.0.1:${address.port}/v2/leases/one/adb`);
      const handshake = once(vendor, 'connection');
      vendor.on('connection', (ws) => ws.on('message', (message) => ws.send(message)));
      const signal = AbortSignal.timeout(10_000);
      tunnel = await connectAdb(
        { url, token: 'lease-token' },
        { ...process.env, ANDROID_HOME: sdk },
        signal,
      );
      const socketPath = tunnel.serial.slice('localfilesystem:'.length);
      const directory = path.dirname(socketPath);
      const metadata = await stat(directory);
      expect(metadata.mode & 0o777).toBe(0o700);
      const local = createConnection(socketPath);
      try {
        const [, request] = await handshake;
        expect(request.headers.authorization).toBe('Bearer lease-token');
        const echoed = once(local, 'data');
        local.write('ADB bytes');
        const [bytes] = await echoed;
        expect(bytes.toString()).toBe('ADB bytes');
      } finally {
        local.destroy();
      }
      await tunnel.close();
      tunnel = undefined;
      await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(directory + '-closed')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await tunnel?.close();
      for (const ws of vendor.clients) ws.terminate();
      await new Promise<void>((resolve) => vendor.close(() => resolve()));
      await new Promise<void>((resolve) => tls.close(() => resolve()));
      await rm(sdk, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform === 'win32')(
  'removes the socket directory when adb exits on its own',
  async () => {
    const root = await mkdtempForTest('adc-supervisor-');
    const directory = path.join(root, 'sockets');
    await mkdir(directory);
    const helper = new URL('./adb-server.mjs', import.meta.url);
    const supervisor = fork(helper, ['/usr/bin/true', directory], { execArgv: [] });
    const [code] = await once(supervisor, 'exit');
    expect(code).toBe(0);
    await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(directory + '-closed')).rejects.toMatchObject({ code: 'ENOENT' });
  },
);
