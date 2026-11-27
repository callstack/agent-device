# Takeover hold on the admitted lease, live through the proxy, 2026-11-23

Evidence for #4288 (as rescoped by #4340): a scripted hold on the caller's
admitted lease, run live on the proxy route. Both the device host and the
agent ran on the same machine, but the agent rode the proxy protocol the way
a remote agent rides a tunnel: a separate state directory, the proxy's bearer
token, and `connect proxy` with the `/agent-device` base path.

## Build and topology

- Source SHA `86439819a`, branch `forge/takeover-scripted`
- Build: `pnpm install --frozen-lockfile && pnpm build` in the branch worktree
- Host side: `agent-device proxy --port 4310` under its own `AGENT_DEVICE_HOME`,
  fronting a daemon that sees the physical Android device
- Agent side: a second `AGENT_DEVICE_HOME`, `AGENT_DEVICE_DAEMON_AUTH_TOKEN`
  set to the token the proxy printed, and `connect proxy --daemon-base-url
  http://127.0.0.1:4310/agent-device --platform android --session s`
- Device: one physical Android unit behind the proxy (serial `<serial>`); the
  app is Settings, driven only to open and close

## The sequence the review asked for

```sh
$ agent-device open com.android.settings --platform android --session s
Opened: com.android.settings
$ agent-device takeover hold --session s --reason "handing to QA" --ttl-ms 60000 --json
{
  "data": {
    "hold": {
      "id": "takeover-2f986370-2d17-4d97-a27a-d7728c3a5b62",
      "scope": {
        "backend": "android-instance",
        "leaseProvider": "proxy",
        "deviceKey": "<device-key-from-the-lease>"
      },
      "state": "active",
      "reason": "handing to QA",
      "expiresAt": 1795410107294
    }
  }
}
```

The hold's scope names the lease's device. No flag named a device, backend or
provider; the saved connection carries `leaseBackend` and `platform`, and the
hold still takes its identity from the admitted lease.

A mutation while the hold is up refuses and does not wait:

```sh
$ agent-device close com.android.settings --platform android --session s
Error (DEVICE_IN_USE): A human is interacting with this simulator or device;
agent interactions are temporarily disabled. Next: Wait until the human-control
hold is released before retrying.
```

A read in the same window succeeds (`snapshot --session s` wrote its PNG). The
release reopens the route:

```sh
$ agent-device takeover release takeover-2f986370-... --session s
Released human-control hold takeover-2f986370-2d17-4d97-a27a-d7728c3a5b62.
$ agent-device open com.android.settings --platform android --session s
Opened: com.android.settings
```

## Ownership: another lease cannot touch the hold

Session `s` created the hold first:

```sh
$ agent-device open com.android.settings --platform android --session s
Opened: com.android.settings
$ agent-device takeover hold --session s --reason "ownership demo" --ttl-ms 120000 --json
{
  "data": {
    "hold": {
      "id": "takeover-9617435c-edd6-4084-adce-189302ddc2ff",
      "scope": {
        "backend": "android-instance",
        "leaseProvider": "proxy",
        "deviceKey": "<device-key-from-the-lease>"
      },
      "state": "active",
      "reason": "ownership demo",
      "expiresAt": 1795410297152
    }
  }
}
```

A second session `s2` connected to the same proxy and admitted its own lease
on another device (an iOS simulator). Its release of session `s`'s live hold
is refused as a typed ownership violation:

```sh
$ agent-device takeover release takeover-9617435c-... --session s2
Error (UNAUTHORIZED): Human-control hold does not belong to the admitted lease.
Next: Refresh daemon metadata and retry the command.
$ agent-device takeover release takeover-9617435c-... --session s
Released human-control hold takeover-9617435c-edd6-4084-adce-189302ddc2ff.
```

A second lease on the same device cannot exist at all: `s2`'s open on the
Android unit answers `DEVICE_IN_USE` ("Device is already leased"), so the
hold's population stays the device-scoped leases the daemon serves for that
one admitted device.

## Expiry ends the window

```sh
$ agent-device takeover hold --session s --ttl-ms 5000
$ agent-device close com.android.settings --platform android --session s
Error (DEVICE_IN_USE): A human is interacting with this simulator or device...
$ sleep 6
$ agent-device close com.android.settings --platform android --session s
Closed: s
```

After the TTL the mutation passes without a release; a later `takeover
release` of the expired hold answers "No active hold found".

## What this run does not claim

- The route is the local loopback: one machine, two `AGENT_DEVICE_HOME`s, the
  proxy protocol over `127.0.0.1`. No tunnel or cloud provider was in the
  path, and the daemon-side admission saw a proxy lease.
- Drain-before-active (an in-flight mutation finishing while the hold lands)
  is daemon-side behavior this run did not stage; the dispatch chain's own
  coverage owns it.

## Cleanup

The proxy process was stopped and both state directories were removed after
the run.
