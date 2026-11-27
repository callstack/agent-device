# @agent-device/proxy

The proxy behind `agent-device proxy`, as a library. Embed it in your own gateway to give remote
`agent-device` clients access to a daemon on another machine, over whichever transport you choose.

The proxy:

- authenticates clients with a token you choose, or with your own check, and never exposes the
  daemon's own token;
- forwards only the routes a remote client needs: `/health`, `/rpc`, `/rpc/checked`, uploads,
  artifacts, and request diagnostics, each also under `/agent-device/`;
- refuses a `/rpc/checked` call whose `x-agent-device-rpc-protocol` header is missing or names
  another RPC protocol, with a 409 before it forwards anything;
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
and `AGENT_DEVICE_DAEMON_AUTH_TOKEN` set to `clientToken`. Each agent sets its own `AGENT_DEVICE_SESSION`
(or passes `--session`): a command that names no session on a proxy connection is refused.

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
the `Response` back. Four things the proxy relies on:

- Without `publicOrigin`, construct `request.url` with the canonical client-facing URL for each
  request. The embedder is responsible for that URL. `Forwarded` and `X-Forwarded-*` headers do
  not select the upload ticket origin.
- `request.signal` aborts when the client goes away. The proxy then cancels the daemon request, so
  work the client stopped waiting for does not keep running.
- The host keeps the `Request` reachable until the `Response` body ends. Undici's `Request` stops
  following its signal once it is collected, and the abort would then not reach the daemon.
- Response bodies stream. Artifact downloads can be large, so forward the body as it arrives.

`handle` never rejects. Errors come back as JSON responses with a 4xx or 5xx status, except a route
the proxy does not serve, which gets a plain `Not found` 404.

### Serve uploads through a TLS tunnel

Set `publicOrigin` to the public HTTP(S) origin when TLS terminates before the proxy, for example
`https://public.example:8443`. Use the scheme, host and optional port, without credentials, a path,
query or fragment. With the CLI, run
`agent-device proxy --port 4310 --public-origin https://public.example:8443`. For an ephemeral
tunnel, obtain its public name first, then configure and restart the proxy. This replaces the
previous first-`X-Forwarded-Proto` behavior.

Without a fixed origin, the Node listener uses the actual socket scheme and one validated `Host`
header. Actual Node HTTPS sockets are supported. A custom direct-daemon HTTP embedding behind TLS
termination can pass `publicOrigin` to `createDaemonHttpServer`. The built-in daemon listens on
loopback HTTP; expose it behind TLS through a configured proxy.

Your Node HTTP client must send exactly one valid `Host` header on every request, including
`/health`. Missing, duplicate or malformed Host headers receive HTTP 400, even with `publicOrigin`
configured. Configure raw-socket and HTTP/1.0 health probes to send `Host: localhost` (or your
deployment's host and port).

### How the proxy reaches the daemon

On artifact transfer routes — `POST /upload`, `/upload/preflight` and `/upload/finalize`,
`PUT /upload/direct/*` and `GET /artifacts*` — the proxy forwards with `node:http` / `node:https`.
Each transfer has a connect limit of 30 seconds, a response-header wait of 30 seconds that
starts only once its own outgoing body has finished and the connection is established, and a
120-second limit on body inactivity. For downloads, that limit counts time spent waiting for
upstream bytes while you read the response; it pauses when you stop reading. Every forwarded
exchange also ends at 600 seconds regardless of how steadily its bytes move. Your `upstreamTimeoutMs`
is an additional cap. The earliest caller cancellation, operator cap, phase limit or aggregate expiry
ends the exchange. A transfer does not retry or restart its aggregate.

Transfer phase and aggregate timeout error responses use HTTP 500 and include `reason`,
`transferPhase` and `timeoutMs`. These fields appear only for `COMMAND_FAILED` with
`reason: transfer_phase_timeout` and the matching connect/header (30000ms) or body (120000ms)
phase budget, or `reason: transfer_forwarding_deadline_exceeded` with
`transferPhase: forwarding` and `timeoutMs: 600000`. Other errors omit these fields.
After the proxy returns a response, a timeout while you consume it fails the body read instead of
replacing its status. Preflight bodies are consumed before ticket rewriting; a timeout there returns
HTTP 500.

On these routes:

- Redirects are returned without being followed. The daemon's `308` resume response keeps its
  `Range` and `x-upload-offset` headers.
- Default request headers added by `fetch`, such as `accept` and `user-agent`, are not sent.
- A patched global `fetch` or an `undici` global dispatcher no longer intercepts the request.

Supply `upstreamFetch` if you need those Fetch behaviors or your own routing.

Environment-proxy routing depends on your runtime. In loopback checks, Node 22.12 ignores
`HTTP_PROXY` and `HTTPS_PROXY` for both transports. Node 26.11.1 uses them when
`NODE_USE_ENV_PROXY=1`. Bun 1.4.2 Fetch uses them without that opt-in, while the default transfer
transport requires it. On Node 26.11.1 and Bun 1.4.2, `NO_PROXY=127.0.0.1` bypasses the proxy.
If your Bun deployment needs proxy routing for transfers, set `NODE_USE_ENV_PROXY=1` or supply
`upstreamFetch`.

By default, `/rpc`, `/health` and request diagnostics use global `fetch`.

### Reach the daemon over your own transport

Pass `upstreamFetch` when the daemon is only reachable some other way, such as a tunnel the device
host opened to your gateway:

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

Honor `request.redirect`. On `/rpc/checked` it is `'error'`: never follow a redirect there, because
a followed redirect resends the call with the daemon token, possibly to the unchecked `/rpc`. The
proxy refuses a checked answer that is a redirect or reports `redirected`, but it cannot undo a
request your transport already resent.

On transfer routes, the proxy bounds its wait for your transport and response body. It settles on
your abort, your `upstreamTimeoutMs`, its 600-second aggregate and its demand-aware response-body
inactivity limit. Work your transport starts can keep running if it ignores `request.signal`. The
proxy does not wait for that work or for a cancellation callback that never settles. It cannot
measure a connect or a header wait it does not own, so on transfer routes your transport keeps those
obligations. Bound connection establishment to 30 seconds and the response-header wait to 30 seconds
once the connection is established and the outgoing body has finished. Stream `request.body` with
120-second body inactivity limits. Stop your request and response sources on cancellation. A body
pull alone does not confirm that an outgoing byte was sent.

### Authenticate each client yourself

One `clientToken` is shared by every client. To give each client its own credential, pass
`authenticate` instead. It receives each client request (with its body on `/rpc` and
`/rpc/checked`) and returns the tenant the client acts as, or `null` to refuse it with a 401. On
`/rpc/checked` it runs before the envelope check, so the body may not be JSON:

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
hyphens; any other id fails the request with a 500. On `/rpc` and `/rpc/checked` the proxy accepts
only `agent_device.command` and the `agent_device.lease.*` methods (or the same names spelled
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
| `upstreamFetch` | none | Sends one request to the daemon. Without it, transfer routes use `node:http(s)` and every other route uses the global `fetch`. |
| `maxRpcBodyBytes` | 64 MiB, the daemon's own request limit | Larger `/rpc` bodies get a 400 response. |
| `upstreamTimeoutMs` | none | Independent cap on one daemon request, including its body. `/health` keeps its separate five-second limit. Without this option, other requests last as long as the client waits, bounded by the client's command timeout and, on transfer routes, the 600-second forwarding aggregate. |

`maxRpcBodyBytes` limits the bytes of one `/rpc` body. The proxy reads the whole body before it
authenticates the client, then decodes and parses it. One unauthenticated request can therefore
hold more memory than the limit: the raw bytes plus the decoded string and the parsed request. For
a proxy that faces the internet, set `maxRpcBodyBytes` lower than the 64 MiB default, to the largest
request your clients send.

After the limit check, the proxy rewrites the body: it adds the daemon token and, with
`authenticate`, the tenant fields. The rewritten body can be a few hundred bytes larger than the
client's. The daemon applies its own 64 MiB limit, so a client body within that margin of 64 MiB
passes the proxy and the daemon refuses it. Clients refuse requests over 64 MiB before sending them,
so only a body in that narrow margin is affected.

## Health and restarts

`GET /health` (also served as `/agent-device/health`) needs no token. It reports the proxy's version and `instanceId`, and
includes the daemon's own health under `upstream`. A new `createDaemonProxy` call gets a new
`instanceId`, so connected clients notice the restart and re-check the connection before sending
more commands.
