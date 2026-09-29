import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { computeDaemonCodeSignature } from '@agent-device/host-kit/code-signature';
import { findProjectRoot } from '@agent-device/host-kit/version';
import { listenOnLoopback } from './loopback.ts';

// A loopback stand-in for a running daemon: answers `GET /health`, echoes `responseData` as the
// result of every `POST /rpc`, and records what it was asked, for the daemon-client tests that
// decide which daemon a command keeps.

export type HttpDaemonFixture = {
  server: http.Server;
  port: number;
  seenPaths: string[];
  rpcRequests: Record<string, any>[];
};

export async function startHttpDaemonFixture(
  responseData: Record<string, unknown>,
): Promise<HttpDaemonFixture> {
  const seenPaths: string[] = [];
  const rpcRequests: Record<string, any>[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    seenPaths.push(`${req.method ?? 'GET'} ${url.pathname}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200);
      res.end('ok');
      return;
    }

    if (req.method === 'POST' && url.pathname === '/rpc') {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      req.on('end', () => {
        const rpcRequest = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
          string,
          any
        >;
        rpcRequests.push(rpcRequest);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: rpcRequest.id,
            result: { ok: true, data: responseData },
          }),
        );
      });
      return;
    }

    res.writeHead(404);
    res.end('not found');
  });
  const port = await listenOnLoopback(server);
  return { server, port, seenPaths, rpcRequests };
}

/** The code signature a daemon started from this checkout records, so a fixture daemon is reused. */
export function currentDaemonCodeSignature(): string {
  const root = findProjectRoot();
  const distPath = path.join(root, 'dist', 'src', 'internal', 'daemon.js');
  const sourcePath = path.join(root, 'src', 'daemon.ts');
  const entryPath =
    process.execArgv.includes('--experimental-strip-types') || !fs.existsSync(distPath)
      ? sourcePath
      : distPath;
  return computeDaemonCodeSignature(entryPath, root);
}

/** Swaps `process.stderr.write` for a buffer until `restore`, so a test can read what was printed. */
export function captureStderr(): { read: () => string; restore: () => void } {
  const originalWrite = process.stderr.write.bind(process.stderr);
  let captured = '';
  (process.stderr as { write: typeof process.stderr.write }).write = ((chunk: unknown) => {
    captured += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  return {
    read: () => captured,
    restore: () => {
      process.stderr.write = originalWrite;
    },
  };
}
