# Security

Clients trust callers for local paths and remote daemons only for data and checked IDs. Daemons trust their state directory. Nobody trusts the network or other users.
Out of scope: same uid, hostile root, ACLs, mounts, untrusted filesystems.

ADR 0016 checks caller-named script destinations on POSIX against the writer's uid.

New or migrated writes (#4669):

- Authorize a destination where it is written, against the caller's uid, not by identity.
- Accept from a peer only data, an ID bound to a local record (endpoint, tenant, session), or one entry name under an authorized root.
- Validate entry names: type, NUL, empty, `.`, `..`, separators, platform rules.
- Use explicit `path.posix`/`path.win32`. Never fold kernel-resolved paths.
- For caller output, judge each directory as ADR 0016 does.
- Stage inside the judged parent. After async work, re-walk and compare identity.
- Before you append or truncate, verify the opened file descriptor.
- Overwrite only when the caller asked for it.
- Commit by exclusive create, link, or same-filesystem rename, at the restrictive mode.
- Bound remote bytes. Clean up only what you created.
- If delivery fails before commit, keep the previous file and, where required, the action result. Disclose a typed reason.
