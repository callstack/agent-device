# Security boundaries

## Trust boundaries

- The CLI client trusts its caller for destinations on its machine.
- The local daemon trusts its state directory and chosen paths.
- The client trusts a remote daemon for data and validated identifiers, not for paths.
- Nobody trusts the network or other local users.
- A daemon that runs as root has only its caller's filesystem authority.
- Out of scope: the same uid, root as an adversary, ACLs, mount changes, and untrusted filesystems.

## Implemented today

Only the caller-named `--save-script` destination on POSIX follows the directory rules below (ADR 0016, `packages/host-kit/src/internal/atomic-file.ts`).
Its relative and `~/` input is folded lexically first. On Windows, the directory ACL decides.
The remote client binds each publication ID to the endpoint, tenant, and session in a local record (`packages/remote/src/session-script-destination.ts`).

## Rules for new or migrated write sites

- Authorize a destination on the machine that writes it.
  Authentication gives identity, not filesystem authority.
- For a privileged writer, judge each directory against the caller's uid.
- Accept from a peer only data, an identifier bound to a local record, or one entry name under a root the writer authorized.
- Before filesystem work, validate a single-entry name: type, NUL, empty, `.`, `..`, separators, and platform rules.
- For an input with a known dialect, use `path.posix` or `path.win32`.
- Do not fold a path that the kernel resolves with `path.join`, `path.resolve`, or `path.normalize`.
- Before you create below a directory, judge each directory on the route from one `lstat`.
  Apply `..` physically. Resolve an absolute link target from `/`, a relative one from the link's directory.
  Refuse foreign owners and group- or world-writable directories that are not sticky.
  In a sticky shared directory, accept only links this user or root owns, and never create the entry.
  Create missing directories at 0700, one at a time. Judge one that appears concurrently.
- Carry the judged parent into staging and commit. After async work, re-check its identity.
- Choose the final-entry operation: exclusive create, a link for no-clobber, a same-filesystem rename for replace, or a verified descriptor for append.
- Create entries at the restrictive mode. Use `chmod` only before an entry is published.
- Bound remote bytes as they arrive. Clean up only what the operation created.
- If delivery fails before commit, keep the previous file.
- Disclose each delivery failure with a typed reason, and keep the action result where the delivery contract requires it.

## Destination classes: the #4669 proposal

Issue #4669 proposes five classes: caller output, daemon state, client state, private scratch, and a peer-named entry under a local root.
It owns admission, overwrite, mode, and Windows behavior for each class.
Prior art: `openat2(RESOLVE_BENEATH)` and Go `os.Root`. ADR 0016 permits absolute caller destinations, so compare how each establishes directory authority.
