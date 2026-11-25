import { createServer } from 'node:https';
import { readFile } from 'node:fs/promises';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { once } from 'node:events';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { mkdtempForTest } from '@agent-device/test-kit';
import path from 'node:path';
import { expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { connectAdb } from './tunnel.ts';

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
    const fixtures = new URL(
      '../../../test/integration/provider-scenarios/fixtures/',
      import.meta.url,
    );
    const cert = await readFile(new URL('localhost-cert.pem', fixtures));
    const key = await readFile(new URL('localhost-key.pem', fixtures));
    const tls = createServer({ cert, key });
    const oldCA = getCACertificates();
    setDefaultCACertificates([cert.toString()]);
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
    } finally {
      await tunnel?.close();
      for (const ws of vendor.clients) ws.terminate();
      await new Promise<void>((resolve) => vendor.close(() => resolve()));
      setDefaultCACertificates(oldCA);
      await new Promise<void>((resolve) => tls.close(() => resolve()));
      await rm(sdk, { recursive: true, force: true });
    }
  },
);
