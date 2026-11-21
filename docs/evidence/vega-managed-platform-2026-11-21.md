# Vega managed platform plugin — packed-plugin evidence (2026-11-21)

Head: `fix/0.22-web-vega-plugin-host-routing`. Issue #4862. Stacked on #4857.

## Live Vega Virtual Device on this host

The device-facing family was driven on a real Vega Virtual Device, not a stub, with the packed
plugin: SDK `0.23.9221`, Vega CLI `1.3.2` at `/Users/thymikee/vega/bin/vega`.

| Check | Result |
| --- | --- |
| `vega virtual-device status` before the run | `{"running":false,"process_ids":{"qemu":-1}}` |
| `vega virtual-device start` | `Virtual device ready.` / `{"running":true,"process_ids":{"qemu":65432}}` |
| `vega device list` | `VirtualDevice : tv - aarch64 - OS - amazon-f38d6e237d275dd5` |
| Target app | `com.amazondeveloper.keplersampleapp.main` (Kepler sample app, from `vega device installed-apps`) |
| `vega virtual-device status` after the run | `{"running":false,"process_ids":{"qemu":-1}}` |

Setup: a scratch project, an isolated store (`AGENT_DEVICE_HOME`, `AGENT_DEVICE_STATE_DIR`,
`AGENT_DEVICE_CLAIMS_DIR` under scratch), and the core packed and installed, followed by
`agent-device plugins add ./vega.tgz`. The Vega CLI was reachable through the host `PATH` only — the
plugin resolved it with the `isExecutableOnPath` port of the host it was set up with. Every CLI call
ran with `--debug`, so each request wrote its own exec trace.

```
########## agent-device devices --platform vega --json
{
  "success": true,
  "data": {
    "devices": [
      { "platform": "vega", "id": "VirtualDevice", "name": "Vega Virtual Device (VirtualDevice)",
        "kind": "emulator", "target": "tv", "booted": true }
    ]
  }
}

########## agent-device open com.amazondeveloper.keplersampleapp.main --platform vega --target tv --json
{
  "success": true,
  "data": {
    "session": "default",
    "appName": "com.amazondeveloper.keplersampleapp.main",
    "selection": { "reason": "single-booted-local", "source": "local",
                   "candidateCount": 1, "bootOccurred": false },
    "startup": { "durationMs": 1321, "method": "open-command-roundtrip",
                 "appTarget": "com.amazondeveloper.keplersampleapp.main" },
    "platform": "vega", "target": "tv",
    "device": "Vega Virtual Device (VirtualDevice)", "id": "VirtualDevice",
    "kind": "emulator", "serial": "VirtualDevice",
    "message": "Opened: com.amazondeveloper.keplersampleapp.main"
  }
}

########## agent-device tv-remote press down --platform vega --target tv --json
{ "success": true, "data": { "action": "tv-remote", "button": "down",
                             "message": "Pressed TV remote down" } }

########## agent-device close com.amazondeveloper.keplersampleapp.main --platform vega --target tv --json
{ "success": true, "data": { "session": "default", "message": "Closed: default" } }
```

Each CLI reply was then corroborated against the device with the SDK itself, on the same store and
the same packed plugin, in a second pass over the same four steps. `agent-device open`, then a direct
SDK read, then a direct injection, then `agent-device close`, then a direct read again:

```
$ agent-device open com.amazondeveloper.keplersampleapp.main --platform vega --target tv
$ vega device is-app-running --device VirtualDevice --appName com.amazondeveloper.keplersampleapp.main
com.amazondeveloper.keplersampleapp.main is running on VirtualDevice
$ vega device run-cmd --device VirtualDevice --command "inputd-cli button_press KEY_DOWN"
Injecting Button Press As Driver: KEY_DOWN State: short
$ agent-device close com.amazondeveloper.keplersampleapp.main --platform vega --target tv
$ vega device is-app-running --device VirtualDevice --appName com.amazondeveloper.keplersampleapp.main
com.amazondeveloper.keplersampleapp.main is not running on VirtualDevice
```

The two `is-app-running` answers are the device-side claim: the packed plugin's `open` put the app on
screen and its `close` took it off, as read by the SDK rather than by the plugin that did it.

The exec trace of the same four requests, as `--debug` wrote them. Every `vega` call the packed
bundle made is recorded under the request that asked for it, which is what binding to the setup host
buys — a plugin that spawned through its bundled host-kit copy would trace nothing here:

```
{"phase":"exec_command","requestId":"2f356971c3034976","command":"devices","data":{"execId":"70141990-…","command":"vega","event":"spawn","pid":85720,"timeoutMs":10000}}
{"phase":"exec_command","requestId":"2f356971c3034976","command":"devices","data":{"execId":"70141990-…","command":"vega","event":"exit","pid":85720,"timeoutMs":10000,"exitCode":0}}
{"phase":"exec_command","requestId":"c6d9c65e55209661","command":"open","data":{"execId":"12d8c00e-…","command":"vega","event":"spawn","pid":86023,"timeoutMs":10000}}
{"phase":"exec_command","requestId":"c6d9c65e55209661","command":"open","data":{"execId":"e66c8496-…","command":"vega","event":"spawn","pid":86182,"timeoutMs":30000}}
{"phase":"exec_command","requestId":"c6d9c65e55209661","command":"open","data":{"execId":"e66c8496-…","command":"vega","event":"exit","pid":86182,"timeoutMs":30000,"exitCode":0}}
{"phase":"exec_command","requestId":"30e92cbe08c4582a","command":"tv-remote","data":{"execId":"fb8d3455-…","command":"vega","event":"spawn","pid":86755,"timeoutMs":10000}}
{"phase":"exec_command","requestId":"30e92cbe08c4582a","command":"tv-remote","data":{"execId":"fb8d3455-…","command":"vega","event":"exit","pid":86755,"timeoutMs":10000,"exitCode":0}}
{"phase":"exec_command","requestId":"ecedebbd06e541fd","command":"close","data":{"execId":"6f9bac6a-…","command":"vega","event":"spawn","pid":87108,"timeoutMs":30000}}
{"phase":"exec_command","requestId":"ecedebbd06e541fd","command":"close","data":{"execId":"6f9bac6a-…","command":"vega","event":"exit","pid":87108,"timeoutMs":30000,"exitCode":0}}
```

## Packed plugin, one stub Vega CLI, and what the live run does not cover

`packages/platform-vega/test/package-smoke.mjs` runs this as a gate inside `pnpm run check:package`:
discovery, `open`, a remote press, and `close`, each asserted on the argv a stub Vega CLI recorded and
on the `PATH` and `HOME` that reached it, plus the per-request exec trace above. The stub is written
into a directory that is on the launched host `PATH` and nowhere else, so every call that reaches it
came through the plugin's own resolution. The gate was confirmed to fail on the pre-fix base: the
interactor's own calls answered the replies but left the request with zero exec records.

The live run above covers what a stub cannot: real `vega device list` and `launch-app` output shapes,
real `inputd-cli button_press KEY_DOWN` injection on a booted image, and the daemon adopting a device
it did not start. What it does not cover is the failure paths — a CLI that is not on `PATH`, a CLI
that exits non-zero, a device that disappears mid-interaction — which stay covered by the plugin's
unit tests and the packed stub, where each is asserted on its recorded argv.
