#!/usr/bin/env node
// Serves the fixture identity provider page (#2449) over loopback for a lane.
//
// The sign-in sheet is opened by the app against this address, so the page travels through the real
// hosted SafariViewService surface and no external identity provider is involved. The page content
// lives in examples/test-app/src/auth-idp-fixture.ts, which is also what the Maestro flow asserts
// against. It holds fixture values only.
//
//   node --experimental-strip-types examples/test-app/scripts/serve-auth-idp.mjs
//   node --experimental-strip-types examples/test-app/scripts/serve-auth-idp.mjs --delay-ms 6000
//
// `--host`, `--port`, and `--delay-ms` override the fixture identity provider's address and the time
// it holds the loading page. The lane starts this server; see scripts/run-test-app-auth-session-lane.mjs.
//
// Run it with `node --experimental-strip-types`, the repo's convention for a Node entry that imports
// TypeScript: the supported floor here is Node 22.12, where type stripping is still behind that flag.
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const fixturePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'auth-idp-fixture.ts',
);

const args = process.argv.slice(2);
function readFlag(name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : (args[index + 1] ?? fallback);
}

const { AUTH_IDP_DEFAULT_PORT, AUTH_IDP_PATH, renderAuthIdpPage } = await import(
  pathToFileURL(fixturePath).href
);

const host = readFlag('host', '127.0.0.1');
const port = Number(readFlag('port', String(AUTH_IDP_DEFAULT_PORT)));
const delayMs = Number(readFlag('delay-ms', '0'));

let requests = 0;

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://${host}`);
  if (url.pathname !== AUTH_IDP_PATH) {
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not found\n');
    return;
  }

  // Only the first request honours --delay-ms, so a lane can observe the sheet mid-load. A reload
  // or a redirect must not sit in the loading state again.
  const servedDelayMs = requests === 0 ? delayMs : 0;
  const html = renderAuthIdpPage({ delayMs: servedDelayMs });
  requests += 1;
  console.log(`[auth-idp] ${url.pathname} delayMs=${servedDelayMs}`);
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(html),
    'cache-control': 'no-store',
  });
  response.end(html);
});

server.listen(port, host, () => {
  console.log(`[auth-idp] http://${host}:${port}${AUTH_IDP_PATH} delayMs=${delayMs}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
