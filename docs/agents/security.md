# Security boundaries

The CLI client trusts its caller to choose local destinations.
The client trusts a remote daemon for data and validated identifiers.
Script publication takes no path from the daemon. Capture delivery still can (#4518).
The daemon trusts its state directory. Nobody trusts the network or other local users.
Out of scope: same uid, hostile root, ACLs, mounts, untrusted filesystems.

## Applied today

ADR 0016 judges caller-named script destinations on POSIX against the writing process's uid.
Both script publishers stage and commit inside the judged directory.
Remote script delivery caps bytes as they arrive.

## Proposed in #4669; applies once approved

- For caller output, judge each directory as ADR 0016 does.
- For a peer-named entry under a local root, validate the single-entry name before filesystem work.

ADR 0016's staging and byte-cap rules are candidates for that migration.
Screenshot `--out`, contact sheets, the JUnit reporter, trace and recording outputs, client state, and daemon state do not follow these rules yet (#4669).
