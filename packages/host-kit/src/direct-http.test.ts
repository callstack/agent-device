import { afterEach, expect, test } from 'vitest';
import { execFile } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import { closeLoopbackServer, listenOnLoopback } from '@agent-device/test-kit';

// A credential sent over plain http goes only to loopback, and an environment proxy on another host
// would read it in cleartext. Node reads `NODE_USE_ENV_PROXY` at startup, so each case runs a child.

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => closeLoopbackServer(server)));
});

async function serve(seen: string[]): Promise<number> {
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url} ${req.headers.authorization ?? ''}`);
    res.end('ok');
  });
  servers.push(server);
  return await listenOnLoopback(server);
}

const TRANSPORT = path.join(import.meta.dirname, 'direct-http.ts');

async function runChild(script: string, proxyPort: number): Promise<string> {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ['--experimental-strip-types', '--input-type=module', '-e', script],
    {
      env: {
        ...process.env,
        NODE_USE_ENV_PROXY: '1',
        HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
        http_proxy: `http://127.0.0.1:${proxyPort}`,
        NO_PROXY: '',
        no_proxy: '',
      },
    },
  );
  return stdout.trim();
}

test.each([
  [
    'node:http with loadDirectHttpAgent',
    (target: string) => `
      import http from 'node:http';
      import { loadDirectHttpAgent } from ${JSON.stringify(TRANSPORT)};
      const agent = await loadDirectHttpAgent('http:');
      await new Promise((resolve, reject) => {
        const req = http.request(${JSON.stringify(target)}, { agent, headers: { authorization: 'Bearer secret' } }, (res) => { res.resume(); res.on('end', resolve); });
        req.on('error', reject);
        req.end();
      });
      console.log('sent');`,
  ],
  [
    'fetchOverDirectHttp',
    (target: string) => `
      import { fetchOverDirectHttp } from ${JSON.stringify(TRANSPORT)};
      const response = await fetchOverDirectHttp(new Request(${JSON.stringify(target)}, { headers: { authorization: 'Bearer secret' } }));
      console.log(await response.text() === 'ok' ? 'sent' : 'bad');`,
  ],
])('%s reaches loopback directly, never through an environment proxy', async (_label, script) => {
  const proxied: string[] = [];
  const direct: string[] = [];
  const proxyPort = await serve(proxied);
  const targetPort = await serve(direct);

  const output = await runChild(script(`http://127.0.0.1:${targetPort}/rpc`), proxyPort);

  expect(output).toBe('sent');
  expect(proxied).toEqual([]);
  expect(direct).toEqual(['GET /rpc Bearer secret']);
});
