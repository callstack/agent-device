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

## Credential transport

`docs/adr/0041-credential-transport.md` owns the credential transport rule.
The supported remote setup keeps the daemon and the proxy on loopback, and puts TLS or `ssh -L` in front of them.
The threat model for the network is a passive or active party on a link that is not TLS or loopback.
A party that reads TLS traffic or controls the operator's own server is also out of scope.

Apply the rule only at the admission points that ADR 0041 lists.
To add an admission point, show that a first-party credential goes to an operator-configured URL there.
Do not add redirect handling for credential secrecy.
Keep the redirect rules of ADR 0006, cloud auth, and upload streaming. They protect protocol invariants, not secrecy.

If a claim depends on runtime behavior, reproduce it with a script before you write code.
Keep the script at 20 lines or fewer.
Record the runtime version, the platform, every relevant setting, and the observed output.
Proxy, TLS, and redirect claims change with environment settings such as `NODE_USE_ENV_PROXY`, `HTTP_PROXY`, and `NO_PROXY`.

## Proposed in #4669

#4669 proposes private writes for credentials, client state, and daemon state (#4649): create each under a verified state root, and never write through a link at the final name.
Do not apply these before #4669 is approved.
Do not apply the ADR 0016 walk to other caller outputs. Screenshot `--out`, contact sheets, the JUnit reporter, and trace and recording outputs keep a plain write to the path the caller names.
