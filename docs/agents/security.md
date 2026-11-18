# Security boundaries

## Trust boundaries

- The CLI client trusts its caller for destinations on its machine.
- The local daemon trusts its state directory and the paths that it chooses.
- The client trusts a remote daemon for data and validated identifiers, not for paths.
- Nobody trusts the network or other local users.
- Give a daemon that runs as root only its caller.s authority.
- Out of scope: the same uid, root as an adversary, ACLs, mount changes, and untrusted filesystems.

## Rules

- Authorize a destination on the machine that writes it.
  Authentication gives identity, not filesystem authority.
- Accept from a peer only data, validated identifiers, or one entry name under a root that the writer authorized.
- Before filesystem work, validate a single-entry name: type, NUL, empty, `.`, `..`, separators, and platform rules.
- For an input with a known dialect, use `path.posix` or `path.win32`.
- Do not fold a path that the kernel resolves with `path.join`, `path.resolve`, or `path.normalize`.
  The kernel applies `..` from the directory a link leads to.
- Before you create below a directory, establish authority over each directory on the route.
  Resolve each link from its physical parent.
  Refuse foreign owners and group- or world-writable ground that is not sticky.
  Never create the entry in sticky shared ground.
  Judge again a level that appears concurrently.
- Do not use recursive `mkdir` through ground that others control.
- Carry the judged parent into staging and commit. After async work, check its identity again.
- Choose the final-entry operation: exclusive create, a link for no-clobber, a same-filesystem rename for replace, or a verified descriptor for append.
- Create entries at the restrictive mode. Use `chmod` only before an entry is published.
- Bound remote bytes as they arrive. Clean up only what the operation created.
- If delivery fails, keep the previous file and the action result.

## Destination classes

Caller output, daemon state, client state, private scratch, and a peer-named entry under a local root.
Issue #4669 owns moving every write site to one class.
`packages/host-kit/src/internal/atomic-file.ts` owns the caller-output walk (ADR 0016).
Prior art: `openat2(RESOLVE_BENEATH)` and Go `os.Root`. ADR 0016 permits absolute caller destinations, so compare how each establishes directory authority.
