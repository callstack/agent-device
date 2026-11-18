import { once } from 'node:events';
import { createServer } from 'node:http';
import { AUTH_IDP_DEFAULT_URL, AUTH_IDP_PATH, renderAuthIdpPage } from './auth-idp-fixture.ts';

export async function startAuthIdpServer({ delayMs = 0 } = {}) {
  let nextDelayMs = delayMs;
  const server = createServer((request, response) => {
    if (request.url?.split('?', 1)[0] !== AUTH_IDP_PATH) {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found\n');
      return;
    }

    const html = renderAuthIdpPage({ delayMs: nextDelayMs });
    nextDelayMs = 0;
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(html),
      'cache-control': 'no-store',
    });
    response.end(html);
  });

  const url = new URL(AUTH_IDP_DEFAULT_URL);
  const startup = new AbortController();
  const timeout = setTimeout(
    () => startup.abort(new Error('provider was not ready within 15s')),
    15_000,
  );
  try {
    server.listen({ host: url.hostname, port: Number(url.port), signal: startup.signal });
    await once(server, 'listening', { signal: startup.signal });
  } finally {
    clearTimeout(timeout);
  }

  let closed;
  return {
    close() {
      return (closed ??= new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }));
    },
  };
}
