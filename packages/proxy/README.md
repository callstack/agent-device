# @agent-device/proxy

The proxy behind `agent-device proxy`, as a library. Embed it in your own gateway to give remote
`agent-device` clients access to a daemon on another machine, over whichever transport you choose.

The proxy:

- authenticates clients with a token you choose, and never exposes the daemon's own token;
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
import { createDaemonProxyServer } from '@agent-device/proxy/node';

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

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `upstreamBaseUrl` | required | Base URL of the daemon's HTTP server. |
| `upstreamToken` | required | The daemon's auth token. |
| `clientToken` | required | Token clients must send as their daemon auth token. |
| `upstreamFetch` | global `fetch` | Sends one request to the daemon. |
| `maxRpcBodyBytes` | 1 MiB | Larger `/rpc` bodies get a 400 response. |
| `upstreamTimeoutMs` | 5 minutes | Longest time one daemon request may take, including its body. |

## Health and restarts

`GET /health` (also served as `/agent-device/health`) needs no token. It reports the proxy's version and `instanceId`, and
includes the daemon's own health under `upstream`. A new `createDaemonProxy` call gets a new
`instanceId`, so connected clients notice the restart and re-check the connection before sending
more commands.
