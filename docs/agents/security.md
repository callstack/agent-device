# Security

A client trusts its caller for local paths, and a remote daemon only for data and checked IDs.
A daemon trusts its state directory. Nobody trusts the network or other local users.
Out of scope: same uid, root as adversary, ACLs, mounts, untrusted filesystems.

ADR 0016 judges caller-named script destinations on POSIX against the writer's uid.
Remote publication IDs bind to endpoint, tenant, and session.

New or migrated write sites:

- Authorize a destination where it is written. Authentication is identity only.
- Authorize a privileged write against the caller's uid.
- Accept from a peer only data, a locally bound ID, or one entry name under an authorized root.
- Validate entry names: type, NUL, empty, `.`, `..`, separators, platform rules.
- Use explicit `path.posix` or `path.win32`. Never fold a kernel-resolved path lexically.
- For caller output, judge each directory as ADR 0016 does.
- Commit into the judged parent. After async work, re-walk and compare identity.
- Commit by exclusive create, no-clobber link, same-filesystem rename, or descriptor append, at the restrictive mode.
- Bound remote bytes. Clean up only what you created.
- Before commit, a failed delivery keeps the previous file. Disclose it with a typed reason. Keep the action result where required.

#4669 proposes destination classes. Prior art: `openat2(RESOLVE_BENEATH)`, Go `os.Root`.
