import http from 'node:http';
import https from 'node:https';
import { createDaemonProxy, createDaemonProxyRequestListener } from '@agent-device/proxy';
import { createHostFrontEnd, withHostPrincipal } from './host-front-end.ts';
import type { HostServiceCredential } from './service-credential.ts';

export type HostTlsMaterial = Readonly<{ cert: Buffer; key: Buffer }>;

/**
 * The Host front-end (ADR 0021 §3): the daemon proxy's transport, uploads, artifacts and
 * upstream token rewrite, authenticated by the persistent service credential, behind the Host
 * route policy, with the credential's principal on every loopback request.
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
    upstreamFetch: (request) => fetch(withHostPrincipal(request, options.credential.principal)),
  });
  const listener = createDaemonProxyRequestListener(createHostFrontEnd(proxy, options.credential));
  return options.tls
    ? https.createServer({ cert: options.tls.cert, key: options.tls.key }, listener)
    : http.createServer(listener);
}
