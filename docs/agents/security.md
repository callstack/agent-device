# Security boundaries

Trust the caller for local paths and the daemon for data and validated identifiers.
Trust the daemon state directory. Treat the network and other local users as untrusted.
Out of scope: same uid, hostile root, ACLs, mounts, untrusted filesystems.

## Applied today

Script publishers use caller paths. On POSIX, apply ADR 0016 checks and stage in the checked directory.
Cap bytes in remote script delivery.
For remote record stop, honor explicit caller paths. Reuse a saved path only with a matching producer grant. Otherwise use a local basename (#4518).
Trace and perf still accept daemon paths.

## Proposed in #4669

Apply proposed path checks, staging, and byte caps only after #4669 is approved.
Pending: screenshot `--out`, contact sheets, JUnit, trace, recording, and client and daemon state.
