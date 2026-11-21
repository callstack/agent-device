# HarmonyOS managed platform plugin — packed-plugin evidence (2026-11-20)

Head: `refactor/0.22-harmonyos-platform-plugin`. Issue #4317, PR #4857.

## Live HarmonyOS target: not available on this host

The host has the toolchain but no target, so no real device or emulator was driven for this change.

| Check | Result |
| --- | --- |
| `hdc` present | Yes — `/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/toolchains/hdc` (with `DEVECO_SDK_HOME=/Applications/DevEco-Studio.app/Contents/sdk`) |
| `hdc list targets` | `[Empty]` (re-checked after the first run) |
| Startable emulator image | None. `/Applications/DevEco-Studio.app/Contents/tools/emulator` carries the emulator binary, and there is no image directory (`~/.Huawei` and `~/Library/Huawei` do not exist; the only Huawei support directory is `Library/Application Support/Huawei/DevEcoStudio5.1`, which holds IDE settings). Downloading an image needs the IDE's signed-in account and its license acceptance, which is not something this run can do unattended. |

No live-device claim is made anywhere in this PR. The device-facing behavior is covered by the packed
fixture below plus the plugin's unit coverage of every HDC argv.

## Packed plugin, one stub HDC, reachable only through `HDC_SDK_PATH`

`packages/platform-harmonyos/test/package-smoke.mjs` runs this sequence as a gate inside
`pnpm run check:package`: `devices`, `open`, `snapshot -i`, `screenshot`, `press` and `close`, each
asserted on its CLI reply and on the argv the stub recorded. What follows is a manual run of the same
sequence against this host, kept because it shows the raw replies and the exec trace the plugin's
commands land in.

Setup: a scratch project, an isolated store (`AGENT_DEVICE_HOME`, `AGENT_DEVICE_STATE_DIR`,
`AGENT_DEVICE_CLAIMS_DIR` under scratch), `PATH` reduced to the Node directory, `/usr/bin` and
`/bin`, and the three documented toolchain roots unset except `HDC_SDK_PATH`. The stub `hdc` is
written into that root only, so any call that reaches it came from the plugin's own root probing and
not from a host `PATH` lookup. The core was packed and installed, then
`agent-device plugins add ./harmonyos.tgz`.

```
########## agent-device devices --platform harmonyos --json
{
  "success": true,
  "data": {
    "devices": [
      { "platform": "harmonyos", "id": "127.0.0.1:5555", "name": "StubPhone",
        "kind": "device", "target": "mobile", "booted": true }
    ]
  }
}

########## agent-device open com.example.app --platform harmonyos --json
{
  "success": true,
  "data": {
    "session": "default",
    "appName": "com.example.app",
    "appBundleId": "com.example.app",
    "selection": { "reason": "single-booted-local", "source": "local", "candidateCount": 1 },
    "platform": "harmonyos",
    "target": "mobile",
    "device": "StubPhone",
    "id": "127.0.0.1:5555",
    "message": "Opened: com.example.app"
  }
}

########## agent-device snapshot -i --platform harmonyos --json
{
  "success": true,
  "data": {
    "nodes": [
      { "index": 0, "type": "Button", "value": "Continue",
        "rect": { "x": 84, "y": 1127, "width": 1088, "height": 168 },
        "enabled": true, "visibleToUser": true, "hittable": true, "depth": 1,
        "ref": "e1", "kind": "button" }
    ],
    "visibility": { "partial": false, "visibleNodeCount": 1, "totalNodeCount": 1 },
    "keyboard": { "kind": "unmeasurable", "reason": "keyboard-window-not-listed" },
    "snapshotDiagnostics": {
      "stats": { "count": 1, "platform": "harmonyos", "backends": { "harmonyos-uitest": 1 } }
    }
  }
}

########## agent-device press 100 200 --platform harmonyos --json
{ "success": true, "data": { "x": 100, "y": 200, "message": "Tapped (100, 200)", "targetKind": "point" } }

########## agent-device screenshot /tmp/hdckit/shot.png --platform harmonyos --json
{ "success": true, "data": { "path": "/tmp/hdckit/shot.png" } }

########## agent-device close --platform harmonyos --json
{ "success": true, "data": { "session": "default", "message": "Closed: default" } }
```

Every HDC call the packed bundle made, with the `PATH` it was handed (the stub's own record):

```
ARGS: list targets
ARGS: -t 127.0.0.1:5555 shell param get const.product.name
ARGS: -t 127.0.0.1:5555 shell param get const.build.characteristics
ARGS: -t 127.0.0.1:5555 shell bm dump -n com.example.app
ARGS: -t 127.0.0.1:5555 shell aa start -a EntryAbility -b com.example.app -m entry
ARGS: -t 127.0.0.1:5555 shell uitest dumpLayout -p /data/local/tmp/agent-device-layout-….json
ARGS: -t 127.0.0.1:5555 file recv /data/local/tmp/agent-device-layout-….json …/layout.json
ARGS: -t 127.0.0.1:5555 shell rm -f /data/local/tmp/agent-device-layout-….json
ARGS: -t 127.0.0.1:5555 shell hidumper -s WindowManagerService -a -a
ARGS: -t 127.0.0.1:5555 shell uitest uiInput click 100 200
ARGS: -t 127.0.0.1:5555 shell snapshot_display -f /data/local/tmp/agent-device-screen-….jpeg
ARGS: -t 127.0.0.1:5555 file recv /data/local/tmp/agent-device-screen-….jpeg /tmp/hdckit/shot.png
ARGS: -t 127.0.0.1:5555 shell rm -f /data/local/tmp/agent-device-screen-….jpeg
```

Each line's recorded `PATH` was `/tmp/hdckit:` followed by the host `PATH`: the plugin prepends the
root it resolved, so the calls reached the stub while the core named no HarmonyOS configuration.

The same request under `--debug` shows the spawns in the request's own exec trace, which is what
binding to the setup host buys — a plugin that spawned through its bundled host-kit copy would trace
nothing here:

```
{"phase":"exec_command","requestId":"6a550a1ab3605fb3","command":"press","data":{"execId":"cc614109-…","command":"hdc","event":"spawn","pid":49635,"timeoutMs":15000}}
{"phase":"exec_command","requestId":"6a550a1ab3605fb3","command":"press","data":{"execId":"cc614109-…","command":"hdc","event":"exit","pid":49635,"exitCode":0,"signal":null}}
{"phase":"request_success","requestId":"6a550a1ab3605fb3","command":"press"}
```

## What this proves and what it does not

Proves: the packed plugin resolves HDC from `HDC_SDK_PATH` through the host it was set up with, runs
discovery, launch, snapshot, interaction, capture and close on that route, and its commands are
traceable to the request that asked for them.

Does not prove anything about a real HarmonyOS device: no target exists on this host, so device-side
behavior (real layout shape, real `aa start` output, real capture encoding, keyboard measurement) is
unchanged from before this refactor and unverified by it.
