# Web managed platform plugin — packed-plugin evidence (2026-11-21)

Head: `fix/0.22-web-vega-plugin-host-routing`. Issue #4862. Stacked on #4857.

## No real browser involved, by design

The web family's tool is the managed `agent-browser` backend the plugin installs under the store. A
real browser install needs a network fetch and a Chrome download, and its replies are not stable
enough to assert on, so both the gate and this manual run answer with a stub over the fixture install
the test kit already writes (`packages/test-kit/src/web-managed-agent-browser.ts`): the same entry
script path, the same console shim, and the same runtime home and socket directories the plugin builds
for a real install. Nothing about the route under test depends on what answers behind that entry.

What follows is a manual run of the packed plugin against that stub on this host, kept because it
shows the raw replies, the environment that reached the backend, and the exec trace — none of which
the gate prints.

Setup: a scratch project, an isolated store (`AGENT_DEVICE_HOME`, `AGENT_DEVICE_STATE_DIR`,
`AGENT_DEVICE_CLAIMS_DIR` under scratch), `PATH` reduced to the Node directory, `/usr/bin` and `/bin`,
the core packed and installed, then `agent-device plugins add ./web.tgz`. The stub entry records every
invocation with the `HOME` and `AGENT_BROWSER_SOCKET_DIR` it was handed. Every CLI call ran with
`--debug`.

```
########## agent-device devices --platform web --json
{
  "success": true,
  "data": {
    "devices": [
      { "platform": "web", "id": "agent-browser-chrome", "name": "Agent Browser Chrome",
        "kind": "device", "target": "desktop", "booted": true }
    ]
  }
}

########## agent-device web doctor --json
{
  "success": true,
  "data": {
    "status": {
      "version": "0.39.0",
      "installed": true, "nodeMajor": 26, "nodeSupported": true,
      "entryScript": "/tmp/weblive/state/tools/agent-browser/0.39.0/package/node_modules/agent-browser/dist/cli.js"
    },
    "stdout": "{\"success\":true,\"data\":{}}\n", "stderr": "", "exitCode": 0
  }
}

########## agent-device open https://example.test --platform web --json
{
  "success": true,
  "data": {
    "session": "web-evidence",
    "appName": "https://example.test",
    "selection": { "reason": "single-booted-local", "source": "local",
                   "candidateCount": 1, "bootOccurred": false },
    "startup": { "durationMs": 506, "method": "open-command-roundtrip",
                 "appTarget": "https://example.test" },
    "platform": "web", "target": "desktop", "device": "Agent Browser Chrome",
    "id": "agent-browser-chrome:session:p_web-evidence", "kind": "device",
    "message": "Opened: https://example.test"
  }
}

########## agent-device press 100 200 --platform web --json
{ "success": true, "data": { "x": 100, "y": 200, "message": "Tapped (100, 200)", "targetKind": "point" } }

########## agent-device screenshot /tmp/weblive/shot.png --platform web --json
{ "success": true, "data": { "path": "/tmp/weblive/shot.png" } }

########## agent-device snapshot --platform web --json
{
  "success": true,
  "data": {
    "nodes": [], "truncated": false, "appName": "https://example.test",
    "snapshotDiagnostics": {
      "stats": { "count": 1, "p50Ms": 433, "p95Ms": 433, "maxMs": 433,
                 "slowThresholdMs": 1500, "platform": "web",
                 "backends": { "agent-browser": 1 } }
    }
  }
}

########## agent-device close --platform web --json
{ "success": true, "data": { "session": "web-evidence", "message": "Closed: web-evidence" } }
```

Every managed-backend call the packed bundle made, with the environment it was handed (the stub's own
record). Each call was spawned as `node <entryScript>`, so the record shows argv plus the managed home
and socket dir the plugin built — both reached the child, on every call:

```
ARGS: doctor --offline --quick
ARGS: open https://example.test --json --session p_web-evidence
ARGS: mouse move 100 200 --json --session p_web-evidence
ARGS: mouse down --json --session p_web-evidence
ARGS: mouse up --json --session p_web-evidence
ARGS: screenshot /tmp/weblive/shot.png --json --session p_web-evidence
ARGS: snapshot --json --session p_web-evidence
ARGS: close --json --session p_web-evidence

HOME:   /var/folders/…/T/agent-device-web/76dbf75458e3   (every call)
SOCKET: /var/folders/…/T/adw/76dbf75458e3                (every call)
```

The exec trace of those requests, as `--debug` wrote them. Two commands matter here for different
reasons. `open` shows the backend spawn plus the process-table read that derives the owned-process
record — that read is the call no backend reply can show, and it goes through the host's
`processes.list` port. `press` shows the three-spawn pointer sequence attributed to one request:

```
{"phase":"exec_command","requestId":"f178ac3051b20133","command":"open","data":{"execId":"cd318f35-…","command":"node","event":"spawn","pid":13307,"timeoutMs":30000}}
{"phase":"exec_command","requestId":"f178ac3051b20133","command":"open","data":{"execId":"23873a98-…","command":"ps","event":"spawn","pid":13309,"timeoutMs":1500}}
{"phase":"exec_command","requestId":"5fc832773ef73f6e","command":"press","data":{"execId":"23d67b87-…","command":"node","event":"spawn","pid":13368,"timeoutMs":30000}}
{"phase":"exec_command","requestId":"5fc832773ef73f6e","command":"press","data":{"execId":"79ff9a96-…","command":"node","event":"spawn","pid":13391,"timeoutMs":30000}}
{"phase":"exec_command","requestId":"5fc832773ef73f6e","command":"press","data":{"execId":"c8a3a2e3-…","command":"node","event":"spawn","pid":13417,"timeoutMs":30000}}
```

The interactor's capture timer reports through the host as well, so one timing record is attributed to
the request that asked for the capture:

```
{"phase":"snapshot_capture","requestId":"abc60ce021b914f9","command":"snapshot","durationMs":433,"data":{"backend":"web"}}
```

## Packed gate and what this does not cover

`packages/platform-web/test/package-smoke.mjs` runs the same interaction as a gate inside
`pnpm run check:package`, asserting the recorded argv, the managed home and socket dir on every call,
the per-request exec records, and the capture timing. The gate was confirmed to fail on the pre-fix
base on the one call no backend reply can show: the `open` request traced its backend spawn but no
process-table read, because the fleet-record scan went to the bundle's own copy of the store.

Proves: the packed plugin spawns the managed backend, builds its managed environment, reads the host
process table, and times a capture — all on the host it was set up with, all attributable to the
request that asked for it.

Does not prove anything about a real browser: page content, real DOM snapshot shape, real capture
encoding, ref rects, and network interception are unchanged by this refactor and unverified by it.
