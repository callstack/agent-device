# Security boundaries

The CLI client trusts its caller to choose local destinations.
The client trusts a remote daemon for data and validated identifiers.
Script publication and remote record stop take no path from the daemon. Trace and perf delivery still can (#4518).
The daemon admits its state directory. Nobody trusts the network or other local users.
Out of scope: same uid, hostile root, ACLs, mounts, untrusted filesystems.

## Applied today

ADR 0016 judges caller-named script destinations on POSIX against the writing process's uid.
Both script publishers commit in the judged directory.
Remote script delivery caps in-memory bytes and error answers.
Remote record stop never takes a daemon path: use the request's path or one plain cwd file name, and warn (#4518).
Stage recordings privately in one resolved parent, then rename. A parent other users can write is the caller's choice.

## Proposed in #4669

Apply proposed path checks, staging, and byte caps only after #4669 is approved.
Pending: screenshot `--out`, contact sheets, JUnit, trace, recording, and client and daemon state.
