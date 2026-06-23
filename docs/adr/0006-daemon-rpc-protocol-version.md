# ADR 0006: Daemon RPC Protocol Version

## Status

Accepted

## Context

`agent-device` can run a client on one machine and reach a daemon on another machine through the
HTTP JSON-RPC transport, including `agent-device proxy` in front of a local macOS daemon. Client and
remote host package versions can differ. Many version skews are safe because the client sends a
stable command request envelope and the daemon executes only the requested command.

Package semver is too strict for this boundary: a 0.15 client and 0.17 remote daemon can often
interoperate. At the same time, the client needs a cheap way to fail before sending command RPC when
the transport protocol itself is no longer compatible.

## Decision

The daemon HTTP `/health` payload advertises a `rpcProtocolVersion` integer alongside service and
package version metadata. Remote clients compare this value before sending JSON-RPC requests.

Package `version` is diagnostic only and must not be used as a compatibility gate. Missing
`rpcProtocolVersion` is treated as a legacy remote daemon and is allowed unless a later security or
protocol decision explicitly retires legacy compatibility.

`rpcProtocolVersion` changes only when an older client and newer daemon, or newer client and older
daemon, cannot safely communicate over the HTTP RPC boundary for existing commands. Bump it for
breaking changes to:

- HTTP route requirements for `/health`, `/rpc`, `/upload`, or `/artifacts/*`.
- Authentication semantics required to authorize RPC, upload, or artifact requests.
- JSON-RPC envelope shape, method naming, request id handling, or command request projection.
- Response, error, artifact, upload, or progress-stream framing that existing clients parse.
- Existing command request or response contracts when the old side would misinterpret the payload
  rather than fail clearly.

Do not bump it for additive changes:

- New commands.
- New optional request fields or flags that older daemons can ignore or reject with a normal
  command error.
- New optional response fields that older clients can ignore.
- Package version changes, refactors, or implementation-only daemon/proxy changes.

When a single command needs finer-grained compatibility in the future, prefer command-level feature
or capability metadata over bumping the whole RPC protocol, unless the shared transport contract is
also affected.

## Alternatives Considered

- Gate by package version: simple, but rejects compatible version skew and makes proxy usage brittle
  across frequent releases.
- Do not check compatibility: maximizes compatibility but fails later, after the client has sent an
  RPC payload that a remote daemon may parse incorrectly.
- Full schema negotiation: more precise, but too much machinery for the current JSON-RPC boundary.

## Consequences

Protocol-breaking changes must update `DAEMON_RPC_PROTOCOL_VERSION`, tests that assert `/health`
metadata, and at least one remote-client regression test that proves mismatched protocols fail before
command RPC.

Legacy remote daemons without `rpcProtocolVersion` remain reachable. This keeps the first release of
the proxy compatible with older HTTP daemons, but it means absence of the marker is not proof of
compatibility.
