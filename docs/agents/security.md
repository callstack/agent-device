# Security boundaries

The CLI client trusts its caller to choose local destinations.
The client trusts a remote daemon for data and validated identifiers.
Script publication takes no path from the daemon. Capture delivery still can (#4518).
The daemon admits its state directory. Nobody trusts the network or other local users.
Out of scope: same uid, hostile root, ACLs, mounts, untrusted filesystems.

## Applied today

ADR 0016 judges caller-named script destinations on POSIX against the writing process's uid.
Both script publishers commit in the judged directory.
Remote script delivery caps in-memory bytes and error answers.

## Proposed in #4669

#4669 proposes judging caller output as ADR 0016 does, and validating a peer-named entry's single name before filesystem work, with ADR 0016 staging and byte caps as candidates.
Do not apply these before #4669 is approved.
Screenshot `--out`, contact sheets, the JUnit reporter, trace and recording outputs, client state, and daemon state do not follow these rules yet (#4669).
