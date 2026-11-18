# Security boundaries

The CLI client trusts its caller to choose destinations on the client machine.
The client trusts a remote daemon for data and validated identifiers, not for paths.
The daemon trusts its state directory. Nobody trusts the network or other local users.
This guide excludes the same uid, a hostile root, ACLs, mounts, and untrusted filesystems.

## Applied today

ADR 0016 judges caller-named script destinations on POSIX against the uid of the writing process.
Both script publishers stage and commit inside the directory that the walk judged.
Remote script delivery limits the downloaded bytes as they arrive.

## Proposed in #4669; applies once approved

- For caller output, judge each directory as ADR 0016 does.
- Stage and commit inside the judged directory.
- Before filesystem work, validate each single-entry name.
- Limit remote bytes as they arrive.

Screenshot `--out`, contact sheets, the JUnit reporter, trace and recording outputs, client state, and daemon state do not follow these rules yet (#4669).
