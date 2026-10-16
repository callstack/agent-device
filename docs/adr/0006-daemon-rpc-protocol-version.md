# ADR 0006: Daemon RPC Protocol Version

## Status

Accepted

## Rules at a glance

- Before remote JSON-RPC requests, compare the daemon's `rpcProtocolVersion` from `/health`.
- Package `version` is diagnostic only and must not control compatibility.
- Permit missing `rpcProtocolVersion` unless a later security or protocol decision explicitly retires legacy compatibility.
- Cache probes only with complete endpoint and upstream instance IDs. Send conditional headers on every cached RPC.
- After a stale-instance refusal, probe again. Retry once only if the new peer's protocol is compatible.
- Change `rpcProtocolVersion` only for unsafe compatibility changes to existing HTTP RPC contracts.
- Keep additive changes at the existing protocol version.
- Treat an absent `capabilities` entry in `daemon.json` as "cannot do this". Never infer a capability from the package version.
- A client never signals a daemon that did not accept a quiesce, except an unreachable daemon it retires deliberately.
- Force-retire a daemon at the drain deadline only when it fails its liveness probes and its command line proves it is a daemon process.

## Context

`agent-device` can run a client on one machine and connect to a daemon on another through HTTP JSON-RPC.
This includes `agent-device proxy` in front of a local macOS daemon.
Client and remote host package versions can differ.
Many version differences are safe because the client sends a stable command request envelope and the daemon executes only the requested command.

Package semver is too strict for this boundary.
A 0.15 client and 0.17 remote daemon can often interoperate.
However, the client needs a low-cost compatibility check before command RPC when the transport protocol is incompatible.

## Decision

The daemon HTTP `/health` payload advertises integer `rpcProtocolVersion` beside service and package version metadata.
Before JSON-RPC requests, remote clients compare this value.

Package `version` is diagnostic only and must not control compatibility.
Missing `rpcProtocolVersion` identifies a legacy remote daemon.
It is permitted unless a later security or protocol decision explicitly retires legacy compatibility.

A persistent client may cache a successful probe if `/health` advertises instance IDs for the daemon endpoint and any proxied upstream daemon.
On every cached RPC, it sends those IDs as conditional headers.
Before dispatch, a daemon refuses a stale instance with a typed HTTP 409 response.
Before it forwards a request, a proxy refuses its own stale instance.
The proxy passes the expected upstream instance to the daemon, which performs the same pre-dispatch check.
After a mismatch, the client clears the cache and probes `/health` again.
Only if the new peer's protocol is compatible does it retry the refused RPC once.
Peers without complete instance IDs retain per-command probes.
A peer that advertises an instance ID must continue to honor conditional RPC headers in future versions.
Older clients may retain a cached identity across a restart.
Before retrying a mutating command, they must receive a pre-dispatch refusal.

`rpcProtocolVersion` changes only when an older client and newer daemon, or newer client and older daemon, cannot safely communicate for existing commands.
This applies to the HTTP RPC boundary.
Increment it for incompatible changes to:

- HTTP route requirements for `/health`, `/rpc`, `/upload`, or `/artifacts/*`.
- Authentication semantics required to authorize RPC, upload, or artifact requests.
- JSON-RPC envelope shape, method names, request id handling, or command request projection.
- Response, error, artifact, upload, or progress-stream framing parsed by existing clients.
- Existing command request or response contracts that the older side would misinterpret instead of clearly rejecting.

Do not increment it for additive changes:

- New commands.
- New optional request fields or flags that older daemons can ignore or reject with a normal command error.
- New optional response fields that older clients can ignore.
- Package version changes, refactors, or daemon/proxy changes limited to implementation.

Unless the shared transport contract also changes, prefer command-level metadata for finer command compatibility.
Feature or capability metadata can supply this information.

## Alternatives Considered

- **Use package version for compatibility.** This is simple but rejects compatible version differences.
  Frequent releases also make proxy use unreliable across versions.
- **Do not check compatibility.** This maximizes attempted compatibility.
  However, failure occurs after the client sends an RPC payload that a remote daemon may parse incorrectly.
- **Negotiate full schemas.** This is more precise but requires excessive machinery for the current JSON-RPC boundary.

## Consequences

Protocol-breaking changes must update:

- `DAEMON_RPC_PROTOCOL_VERSION`.
- Tests for `/health` metadata.
- At least one remote-client regression test that proves mismatched protocols fail before command RPC.

Checks enforce the version rules above (#1432).
`test/wire-compat/surface.ts` declares the wire surface, grouped by the decision's categories.
`test/wire-compat/ledger.json` records each declaration's hash and protocol version.
The unit lane fails if a declaration's shape changes without a corresponding ledger change.
`pnpm check:daemon-wire-compat` compares the ledger with the last released tag.
Changes since that release must have either a protocol increment or a `compatibleChanges` acknowledgment under the additive list above.
Some categories are only partly represented in digests, including `/health` and `/rpc` path literals inside `http-server.ts`.
For those categories, the manifest records the gap and its reason instead of implying coverage.
See `test/wire-compat/README.md`.

Legacy remote daemons without `rpcProtocolVersion` remain reachable.
This keeps the first proxy release compatible with older HTTP daemons.
However, an absent marker does not prove compatibility.

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

The census counts what the contract names and nothing else.
A resumable upload that is still streaming is outside the census. A host-administration
human-control hold that names no lease is also outside it. This is the same boundary that the idle
reap draws. So a quiesce can end both.
A daemon started with an HTTP auth hook marks every HTTP request as remote-origin. Such a daemon
refuses a quiesce over HTTP. The socket transport is unaffected.
