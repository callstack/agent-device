# ADR 0037: Web Session Devices

## Status

Accepted (2026-11-04). A web session is a host-scoped device ([ADR 0035](0035-macos-app-devices.md)),
so ADR 0035's per-device rules apply to it unchanged: the execution lock, the claim, the new-session
conflict check, and the host/scoped-device overlap (`devicesOverlap`).

## Rules at a glance

1. The web host (`agent-browser-chrome`) holds one web session device per backend key, with id
   `<web host id>:session:<backend key>`. Every local web command binds the session device of its
   request; without `--session` the implicit session name (`default`) applies. The web host is never
   bound: it stays an inventory entry and the parent for `devicesOverlap`. Different keys run in
   parallel; separate sessions with the same key conflict in one daemon or across daemons that share
   a claims directory. Workspace-scoped implicit sessions in different workspaces use different
   keys; the same workspace uses one key.
2. A session name matches case-insensitively and must match `[A-Za-z0-9_-]`, be non-empty, and fit
   agent-browser's socket path limit: at most 30 characters, and 17 under tenant isolation. A name
   is never trimmed, so surrounding whitespace is refused. Any other name is refused with
   `INVALID_ARGS`, `reason: 'web_session_name_invalid'`. An explicit empty or whitespace-only name
   (`--session ""`, a blank HTTP `session`) is refused the same way and never falls back to
   `default`; only an absent `--session` maps to `default`. Admission does not trim the name:
   trimming there changed the session keys of other platforms, so the web name rule refuses
   padding instead.
3. The backend key is `p_<name>` with the name in lower case, `w_<workspace scope id>` for an
   implicit workspace session, or `t_<first 12 hex of sha256(tenant id)>_<name>` under tenant
   isolation, so two workspaces or tenants hold two devices and two browsers. Two derivations keep
   these apart. The request scope (`createRequestExecutionScope`)
   is the only place that derives the web identity, the tenant-relative public name and the
   tenant id or workspace scope: it reads the name as the caller supplied it, before tenant scoping,
   and stores it on the request. A batch or replay step carries that identity unchanged. The kernel derives the
   backend key from that identity, never from the tenant-prefixed store name: device resolution
   does so when it selects the session device, and the open of an existing web session does so
   to refuse an invalid name before reusing the session. Every other reader takes the key from
   the device id and passes it to agent-browser as `--session`.
4. First opens serialize on the session device itself, not on the host, so web session opens of one
   host run in parallel.

## Decision details

**Web sessions are devices.** agent-browser isolates a browser per `--session`, so the session is
the unit to lock, claim, and refuse on conflict. One host device serialized every web session.

**One name rule, one key.** The name rule is the backend's own: agent-browser accepts only
`[A-Za-z0-9_-]` and refuses a socket path over 103 bytes, which leaves 32 characters of key. Names
match case-insensitively because names that differ only by case share one socket file on macOS.
Under tenant isolation the key carries a fixed-width hash prefix: a tenant id may hold `.` and 128
characters, which the backend refuses.

**First opens key by the device.** An app device keys its first open by its host (ADR 0035), because
a whole-host open exists beside it. The web host has no whole-host open, so a host key would
serialize web opens for no exclusion.

## Rejected alternatives

- **Readable `<tenant>/<name>` web ids with reserved prefixes.** The backend refuses `/`, `:`, and
  `.`, and tenant ids can exceed the socket budget.
- **One shared browser per tenant.** Two sessions of a tenant would share cookies and storage.
- **The key as a `contracts` type, or derived in `platform-web`.** The key never crosses the wire,
  and device selection would depend on a platform package.
- **Host-level web commands that lock the host.** They serialize every web session and bind a device
  that no session claim covers.
- **Keying web first opens by the host.** See "First opens key by the device".

## Open gaps

- A web open is admitted under a lease of any other backend, because lease admission never compares
  platform with lease backend.
- The 32-character key limit assumes the 48-byte macOS temporary directory.
- A daemon older than this ADR claims the web host itself instead of scanning web session claims, so
  mixed-version daemons on one claims directory do not exclude web sessions correctly. Run one
  version per claims directory, as ADR 0030 requires for process locks.
