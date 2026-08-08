import type { IncomingMessage } from 'node:http';
import { AppError } from '@agent-device/kernel/errors';

/** The slice of `node:http` / `node:https` an outbound request needs. */
export type NodeHttpRequester = Pick<typeof import('node:http'), 'request'>;

/**
 * Loads `node:http` / `node:https` on demand, at the call site that actually
 * issues a request.
 *
 * Importing either for a VALUE initializes undici and, under
 * `NODE_USE_SYSTEM_CA=1`, the platform trust store -- ~79ms per process. Several
 * modules that only *might* speak HTTP (the daemon transport, remote artifact
 * upload/download) sit in the CLI's eager import closure, where the default
 * daemon transport is a plain `node:net` socket and no HTTP request is ever
 * made. `src/__tests__/cli-startup-import-closure.test.ts` fails the build if a
 * static import of either module reappears in that closure.
 *
 * Resolves `.default`, not the namespace, so callers get the very same module
 * object a static `import http from 'node:http'` yields -- its `request`
 * property is mutable, which the transport tests rely on to stub requests.
 */
export async function loadNodeHttpRequester(protocol: string): Promise<NodeHttpRequester> {
  return protocol === 'https:'
    ? (await import('node:https')).default
    : (await import('node:http')).default;
}

export function readNodeHttpResponseBody(res: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      body += chunk;
    });
    res.on('end', () => resolve(body));
    res.on('error', reject);
  });
}

export async function readNodeHttpRequestBody(
  req: IncomingMessage,
  maxBodyBytes: number,
  tooLargeMessage: string,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bodyBytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bodyBytes += buffer.length;
    if (bodyBytes > maxBodyBytes) {
      throw new AppError('INVALID_ARGS', tooLargeMessage);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}
