# Security boundaries

The CLI client trusts its caller to choose local destinations.
The client trusts a remote daemon for data and validated identifiers.
Scripts and remote record stop reject daemon paths (#4518). Trace and perf take them.
The daemon admits its state directory. Nobody trusts the network or other local users.
Out of scope: same uid, hostile root, ACLs, mounts, untrusted filesystems.

## Applied today

ADR 0016 judges caller-named script destinations on POSIX against the writing process's uid.
Both script publishers commit in the judged directory.
Remote script delivery caps in-memory bytes and error answers.

## Proposed in #4669

#4669 proposes private writes for credentials, client state, and daemon state (#4649): create each under a verified state root, and never write through a link at the final name.
Do not apply these before #4669 is approved.
Do not apply the ADR 0016 walk to other caller outputs. Screenshot `--out`, contact sheets, the JUnit reporter, and trace and recording outputs keep a plain write to the path the caller names.
