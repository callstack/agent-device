import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'vitest';
import { probeMetro } from '../session-doctor-metro.ts';

test('probeMetro includes local process cwd when it can resolve the Metro listener', async () => {
  const server = await startMetroStatusServer();
  const cwd = '/tmp/example-app';
  try {
    const check = await probeMetro('127.0.0.1', server.port, 'react-native', {
      resolveProcessInfo: async () => ({ pid: 12345, cwd }),
    });

    assert.equal(check.status, 'pass');
    assert.match(check.summary, /cwd: \/tmp\/example-app/);
    assert.deepEqual(check.evidence?.process, { pid: 12345, cwd });
  } finally {
    await server.close();
  }
});

test('probeMetro ignores local process lookup failures', async () => {
  const server = await startMetroStatusServer();
  try {
    const check = await probeMetro('127.0.0.1', server.port, 'react-native', {
      resolveProcessInfo: async () => {
        throw new Error('lookup failed');
      },
    });

    assert.equal(check.status, 'pass');
    assert.equal(
      check.summary,
      `React Native dev server is reachable at http://127.0.0.1:${server.port}/status.`,
    );
    assert.equal(check.evidence?.process, undefined);
  } finally {
    await server.close();
  }
});

async function startMetroStatusServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('packager-status:running');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    port: address.port,
    close: async () =>
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
