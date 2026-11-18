# Security

Clients trust callers for local paths, remote daemons only for data and checked IDs. Daemons trust their state directory. Nobody trusts the network or other users.
Out of scope: same uid, hostile root, ACLs, mounts, untrusted filesystems.

ADR 0016 checks caller-named script destinations on POSIX against the writer's uid.

New or migrated writes (#4669):

- Authorize a destination where it is written. Authentication alone grants no filesystem authority.
- When an elevated process writes for a caller, authorize the destination against the caller's uid.
- From a peer, accept only data, an ID bound to a local record (endpoint, tenant, session), or one entry name under an authorized root.
- Validate entry names: type, NUL, empty, `.`, `..`, separators, platform rules.
- Use explicit `path.posix`/`path.win32`. Never fold kernel-resolved paths.
- For caller output, judge each directory as ADR 0016 does.
- Stage and commit inside the judged parent. After async work, re-walk and compare identity.
- Before you append or truncate, verify the opened file descriptor.
- At first publication, replace an existing destination only on `--force`. Later revisions of that recording refresh without it.
- Commit by exclusive create, link, or same-filesystem rename at the restrictive mode.
- Bound remote bytes. Clean up only your own creations.
- If delivery fails before commit, keep the previous file. Keep the action result where required. Disclose a typed reason.
