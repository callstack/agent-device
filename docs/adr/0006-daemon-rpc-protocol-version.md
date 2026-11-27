# ADR 0006: Daemon RPC Protocol Version

## Status

Accepted

## Rules at a glance

- Before remote JSON-RPC requests, compare the daemon's `rpcProtocolVersion` from `/health`, or send them on the checked route, where the server makes that comparison.
- The checked route refuses every precondition after authentication and before dispatch, with HTTP 409 and a typed `x-agent-device-refusal` header.
- A client uses the checked route only when its connection opts in. It never resends a checked call and never falls back to `/rpc` after one.
- Package `version` is diagnostic only and must not be used as a compatibility gate.
- Allow a missing `rpcProtocolVersion` unless a later security or protocol decision explicitly retires legacy compatibility.
- A persistent client may cache a successful probe if `/health` advertises an instance ID for the daemon endpoint and, for a proxy, for its upstream daemon.
- Send those instance IDs as conditional headers on every cached RPC. Peers without complete instance IDs retain per-command probes.
- After a stale-instance refusal, clear the cache and probe `/health` again. Retry the refused RPC once, and only if the new peer's protocol is compatible.
- A peer that advertises an instance ID must continue to honor the conditional RPC headers in future versions.
- Change `rpcProtocolVersion` only when older and newer peers cannot safely communicate over the HTTP RPC boundary for existing commands.
- Do not change `rpcProtocolVersion` for additive changes.
- Treat an absent `capabilities` entry in `daemon.json` as "cannot do this". Never infer a capability from the package version.
- A client never signals a daemon that did not accept a quiesce, except an unreachable daemon it retires deliberately.
- After `draining`, force-retire a daemon at the deadline only when it is still running, fails its liveness probes, and its command line proves it is a daemon process.

## Context

`agent-device` can run a client on one machine and reach a daemon on another machine through the HTTP JSON-RPC transport.
This includes `agent-device proxy` in front of a local macOS daemon.
Client and remote host package versions can differ.
Many version differences are safe because the client sends a stable command request envelope and the daemon executes only the requested command.

Package semver is too strict for this boundary.
A 0.15 client and 0.17 remote daemon can often interoperate.
However, the client needs a low-cost way to fail before it sends command RPC if the transport protocol itself is no longer compatible.

## Decision

The daemon HTTP `/health` payload advertises a `rpcProtocolVersion` integer beside service and package version metadata.
Remote clients compare this value before they send JSON-RPC requests.

Package `version` is diagnostic only and must not be used as a compatibility gate.
A missing `rpcProtocolVersion` is treated as a legacy remote daemon.
A legacy remote daemon is allowed unless a later security or protocol decision explicitly retires legacy compatibility.

A persistent client may cache a successful probe if `/health` advertises an instance ID for both the daemon endpoint and, if proxied, its upstream daemon.
The client sends those IDs as conditional headers on every cached RPC.
Before dispatch, a daemon refuses a stale instance with a typed HTTP 409 response.
Before it forwards a request, a proxy refuses its own stale instance.
The proxy passes the expected upstream instance to the daemon, which makes the same pre-dispatch check.
On a mismatch, the client clears the cache and probes `/health` again.
The client then retries the refused RPC once, and only if the new peer's protocol is compatible.
Peers without complete instance IDs retain per-command probes.
A peer that advertises an instance ID must continue to honor the conditional RPC headers in future versions.
The reason is that older clients may hold a cached identity across a restart.
Such clients must receive a pre-dispatch refusal before they retry a mutating command.

### Checked RPC

`POST /rpc/checked` takes the same authentication, body, and answer as `/rpc`.
The client names its protocol in the mandatory `x-agent-device-rpc-protocol` header.
The daemon or proxy authenticates the caller first.
Then it compares that header with its own protocol, before it decodes anything that its own protocol defines.
A missing header or another protocol gets HTTP 409, `x-agent-device-refusal: protocol-missing` or `protocol-mismatch`, and a JSON-RPC error.
The error details name the refusing `service`, its `version`, and its `rpcProtocolVersion`, so the client can name who must upgrade.
A proxy admits `/rpc` and the checked route through one path: body limit, authentication, tenant method rules, credential rewriting, and public-only stamping.
A proxy checks its own protocol, then forwards to the daemon's checked route, which checks again.
The proxy marks a forwarded daemon protocol refusal as `upstream-protocol-mismatch`.
A call that records a session script (`scriptPublicationId`) needs the `script-artifacts` capability; the daemon reads that requirement from the request itself and refuses with `script-artifacts`.
`/health` advertises `checked-rpc` on each link that serves the route.

The route, not a header, is what makes the check safe.
Released daemons and proxies answer an unknown route with 404 before dispatch, and they ignore unknown headers on `/rpc`.
A 404 is still not proof of non-dispatch, because a gateway can answer for a command that ran.
So a client does not discover the route.
The connection opts in with `daemonRpc: "checked"`, which `connect` accepts only when `/health` advertises `checked-rpc` on every link.
With the opt-in, a 404 is a typed failure with `dispatched: 'unknown'`, and the client does not resend.
Flows with remote side effects before the command, such as artifact uploads and lease beats, keep the `/health` probe and the instance headers.
A connect timeout before the socket connects is proof, inside the client, that nothing left; only then does the client run the `/health` recovery loop and send once.

`rpcProtocolVersion` changes only when an older client and newer daemon, or a newer client and older daemon, cannot safely communicate over the HTTP RPC boundary for existing commands.
Increment it for incompatible changes to:

- HTTP route requirements for `/health`, `/rpc`, `/upload`, or `/artifacts/*`.
- Authentication semantics required to authorize RPC, upload, or artifact requests.
- JSON-RPC envelope shape, method names, request id handling, or command request projection.
- Response, error, artifact, upload, or progress-stream framing that existing clients parse.
- Existing command request or response contracts, if the old side would misinterpret the payload instead of failing clearly.

Do not increment it for additive changes:

- New commands.
- New optional request fields or flags that older daemons can ignore or reject with a normal command error.
- New optional response fields that older clients can ignore.
- Package version changes, refactors, or implementation-only daemon/proxy changes.

If a single command needs finer-grained compatibility in the future, prefer command-level feature or capability metadata to an increment of the whole RPC protocol.
This preference does not apply if the change also affects the shared transport contract.

## Alternatives Considered

- **Gate by package version.** This is simple, but it rejects compatible version differences.
  It also makes proxy use brittle across frequent releases.
- **Do not check compatibility.** This maximizes compatibility.
  However, it fails later, after the client has sent an RPC payload that a remote daemon may parse incorrectly.
- **Negotiate full schemas.** This is more precise, but it is too much machinery for the current JSON-RPC boundary.
- **Persist the `/health` answer in the client state directory (#5134).** It saves the probe across CLI processes, but it adds a local trust boundary and cache rules, and a rollback to a daemon that ignores instance headers would dispatch on a stale view.
- **Send the protocol as a header on `/rpc`.** Released daemons ignore unknown headers and dispatch anyway.
- **Fall back to `/health` and `/rpc` after a 404 on the checked route.** A 404 can come after dispatch, so the fallback could run a command twice.

## Consequences

Protocol-breaking changes must update:

- `DAEMON_RPC_PROTOCOL_VERSION`.
- Tests that assert `/health` metadata.
- At least one remote-client regression test that proves mismatched protocols fail before command RPC.

Checks enforce the increment rules above, so nobody has to remember them (#1432).
`test/wire-compat/surface.ts` declares the wire surface, grouped by the bullets in this decision.
`test/wire-compat/ledger.json` records the hash of each declaration and the protocol version of that hash.
The unit lane fails if the shape of a declaration changes and the ledger does not change with it.
`pnpm check:daemon-wire-compat` compares the ledger with the last released tag.
A declaration removed since that release needs a protocol increment; an acknowledgment cannot cover a removal.
A declaration changed since that release needs a protocol increment or a `compatibleChanges` acknowledgment that invokes the additive list above.
Declarations added since that release need neither.
One bullet is only partly digestible: the `/health` and `/rpc` path literals inside `http-server.ts`.
For that gap, the manifest records the gap and its reason instead of implying coverage.
See `test/wire-compat/README.md`.

Legacy remote daemons without `rpcProtocolVersion` remain reachable.
This keeps the first release of the proxy compatible with older HTTP daemons.
However, the absence of the marker is not proof of compatibility.

## Daemon capabilities and quiesce

A daemon on the local state directory publishes `capabilities` in `daemon.json`.
This is the command-level metadata that the decision above prefers over a protocol version bump.
A daemon that predates a capability omits it.
A client treats an absent capability as "cannot do this".
A client never infers a capability from the package version.

`quiesce` is how a client replaces an incompatible daemon without destroying other clients' work.
The client sends `daemon_quiesce` with the daemon token and the pid and start time recorded in
`daemon.json`.
The daemon checks the token and checks that it is that instance.
The daemon refuses a request that reached it as a remote-origin request.
Then the daemon closes admission and counts what it holds in one synchronous step:

- Requests in flight.
- Sessions.
- Repair sessions and live leases.
- Whether the daemon is still starting up (`startingUp`). Before startup completes, the daemon has no drain path.

If any of them is present, the daemon refuses with `daemon-busy` and reopens admission in that same step.
Otherwise, the daemon answers `draining`, keeps admission closed, and shuts down.
The daemon answers the request before dispatch, so it joins neither the in-flight count nor the command registry.

The daemon accepts a quiesce only when it can prove its own start time and the request names both
the pid and that start time. A daemon that cannot prove this is never addressed.

After `draining`, the client sends no signal. The client waits, up to a bounded deadline, for the
daemon to exit by itself and release its registration. The daemon runs its own shutdown. A signal
would cut that shutdown short.
A daemon is force-retired only when it is still running at the deadline, fails its liveness probes,
and its command line proves it is a daemon process.
A daemon that still answers is left alone. The call fails with `daemon-drain-timeout`.
A client never signals a daemon that did not accept a quiesce. The exception is an unreachable
daemon that the client retires deliberately.
A closing daemon stops listening before it removes its registration, so it also reads as unreachable.
A graceful retirement therefore waits 75 s after SIGTERM, longer than the bounded teardown, before it sends SIGKILL.
Two retirements wait less: the cleanup of a client's own failed launch (3 s), and a takeover inside a startup, which the startup ceiling caps.
A detached daemon that finds its registration deleted or replaced by another process closes by itself: no new client can find it. An embedded runtime keeps serving its host.

The census counts what the contract names and nothing else.
A resumable upload that is still streaming is outside the census. A host-administration
human-control hold that names no lease is also outside it. This is the same boundary that the idle
reap draws. So a quiesce can end both.
A daemon started with an HTTP auth hook marks every HTTP request as remote-origin. Such a daemon
refuses a quiesce over HTTP. The socket transport is unaffected.
