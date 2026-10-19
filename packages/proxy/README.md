# @agent-device/proxy

The proxy behind `agent-device proxy`, as a library. Embed it in your own gateway to give remote
`agent-device` clients access to a daemon on another machine, over whichever transport you choose.

The proxy:

- authenticates clients with a token you choose, or with your own check, and never exposes the
  daemon's own token;
- forwards only the routes a remote client needs: `/health`, `/rpc`, uploads, artifacts, and
  request diagnostics;
- refuses install sources that name a file on the daemon host;
- rewrites upload tickets so clients upload through the proxy, not to the daemon directly.

Requires Node.js 22.12 or later.

## Install

```bash
npm install @agent-device/proxy
```

Keep its version close to the daemon behind it. Clients refuse a proxy whose daemon speaks a
different RPC protocol version, before any command runs.

## Serve the proxy over HTTP

```ts
import { createDaemonProxyServer } from '@agent-device/proxy';

const server = createDaemonProxyServer({
  upstreamBaseUrl: 'http://127.0.0.1:4310',
  upstreamToken: process.env.AGENT_DEVICE_DAEMON_TOKEN!,
  clientToken: process.env.GATEWAY_CLIENT_TOKEN!,
});
server.listen(8080);
```

Clients connect with `agent-device connect proxy --daemon-base-url https://gateway.example.com/agent-device`
and `AGENT_DEVICE_DAEMON_AUTH_TOKEN` set to `clientToken`.

To mount the proxy in an existing `node:http` or `node:https` server, use
`createDaemonProxyRequestListener(createDaemonProxy(options))`.

## Bring your own transport

`createDaemonProxy` has no server of its own. It answers standard `Request` objects with standard
`Response` objects, so any Node.js-compatible runtime or framework that speaks the Fetch API can
host it:

```ts
import { createDaemonProxy } from '@agent-device/proxy';

const proxy = createDaemonProxy({
  upstreamBaseUrl: 'http://127.0.0.1:4310',
  upstreamToken: daemonToken,
  clientToken,
});

// A fetch-style server entry, as used by Bun and by Hono on Node.js
export default { fetch: proxy.handle };
```

For a WebSocket or other message transport, turn each incoming message into a `Request` and send
the `Response` back. Three things the proxy relies on:

- `request.url` is the URL the client used. Upload tickets point clients at its origin. An
  `x-forwarded-proto` header overrides the scheme.
- `request.signal` aborts when the client goes away. The proxy then cancels the daemon request, so
  work the client stopped waiting for does not keep running.
- Response bodies stream. Artifact downloads can be large, so forward the body as it arrives.

`handle` never rejects. Errors come back as JSON responses with a 4xx or 5xx status, except a route
the proxy does not serve, which gets a plain `Not found` 404.

### Reach the daemon over your own transport

By default the proxy calls the daemon with the global `fetch`. Pass `upstreamFetch` when the daemon
is only reachable some other way, such as a tunnel the device host opened to your gateway:

```ts
const proxy = createDaemonProxy({
  upstreamBaseUrl: 'http://device-host-17.internal',
  upstreamToken: daemonToken,
  clientToken,
  upstreamFetch: (request) => deviceHostTunnel.send(request),
});
```

`upstreamFetch` receives a `Request` addressed to `upstreamBaseUrl` and must resolve with the
daemon's `Response`. Abort the exchange when `request.signal` aborts.

### Authenticate each client yourself

One `clientToken` is shared by every client. To give each client its own credential, pass
`authenticate` instead. It receives each client request (with its JSON body on `/rpc`) and returns
the tenant the client acts as, or `null` to refuse it with a 401:

```ts
const proxy = createDaemonProxy({
  upstreamBaseUrl: 'http://127.0.0.1:4310',
  upstreamToken: daemonToken,
  authenticate: async (request) => {
    const account = await accounts.findByApiKey(request.headers.get('authorization'));
    return account ? { tenantId: account.id } : null;
  },
});
```

The proxy then sends every authenticated request to the daemon as that tenant, whatever tenant the
client named, and isolates its sessions from other tenants' sessions. `GET /health` is not
authenticated and carries no tenant. A tenant id is 1-128 letters, numbers, dots, underscores or
hyphens; any other id fails the request with a 500. On `/rpc` the proxy accepts only
`agent_device.command` and the `agent_device.lease.*` methods (or the same names spelled
`agent-device.command` and `agent-device.lease.*`), and refuses others with a 401.

Clients upload files with a ticket that names the headers to send. The proxy builds that ticket
from the daemon ticket's `content-type` and the client's own credential, so it never carries the
daemon's token. By default the credential is the client's `authorization` and
`x-agent-device-token` headers. If your clients use another header, such as a cookie or an API key
header, return it as `uploadHeaders` so the upload passes `authenticate` too:

```ts
authenticate: async (request) => {
  const apiKey = request.headers.get('x-api-key');
  if (!apiKey) return null;
  const account = await accounts.findByApiKey(apiKey);
  return account ? { tenantId: account.id, uploadHeaders: { 'x-api-key': apiKey } } : null;
},
```

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `upstreamBaseUrl` | required | Base URL of the daemon's HTTP server. |
| `upstreamToken` | required | The daemon's auth token. |
| `clientToken` | required without `authenticate` | Token clients must send as their daemon auth token. |
| `authenticate` | none | Authenticates each client and names its tenant; replaces `clientToken`. |
| `upstreamFetch` | global `fetch` | Sends one request to the daemon. |
| `maxRpcBodyBytes` | 1 MiB | Larger `/rpc` bodies get a 400 response. |
| `upstreamTimeoutMs` | 5 minutes | Longest time one daemon request may take, including its body. |

## Health and restarts

`GET /health` (also served as `/agent-device/health`) needs no token. It reports the proxy's version and `instanceId`, and
includes the daemon's own health under `upstream`. A new `createDaemonProxy` call gets a new
`instanceId`, so connected clients notice the restart and re-check the connection before sending
more commands.
