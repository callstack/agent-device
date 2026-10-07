import http from 'node:http';
import https from 'node:https';
import { createDaemonProxy, createDaemonProxyRequestListener } from '@agent-device/proxy';
import type { HostServiceCredential } from './service-credential.ts';

export type HostTlsMaterial = Readonly<{ cert: Buffer; key: Buffer }>;

/**
 * The Host front-end (ADR 0021 §3): the daemon proxy's transport, uploads, artifacts and
 * upstream token rewrite, authenticated by the persistent service credential.
 */
export function createHostServer(options: {
  upstreamBaseUrl: string;
  upstreamToken: string;
  credential: HostServiceCredential;
  tls?: HostTlsMaterial;
}): http.Server | https.Server {
  const proxy = createDaemonProxy({
    upstreamBaseUrl: options.upstreamBaseUrl,
    upstreamToken: options.upstreamToken,
    clientToken: options.credential.token,
  });
  const listener = createDaemonProxyRequestListener(proxy);
  return options.tls
    ? https.createServer({ cert: options.tls.cert, key: options.tls.key }, listener)
    : http.createServer(listener);
}
