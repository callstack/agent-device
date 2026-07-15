# iOS Runner Protocol

The Apple runner speaks a small internal HTTP+JSON protocol between the TypeScript daemon and the XCUITest host. This protocol is a maintainer document, not part of the public user docs, but it should stay explicit so the TypeScript and Swift sides do not drift.

## Transport

- Endpoint: `POST /command`
- Content type: `application/json`
- Request body: one JSON command object
- Response body: one JSON envelope

The daemon probes `http://127.0.0.1:<port>/command` for simulator and desktop flows, and can use a tunneled device address for physical iOS/tvOS devices before falling back to localhost.

## Request Shape

Every request includes a `command` field. Additional fields depend on the command family.

Examples:

```json
{ "command": "tap", "x": 120, "y": 240 }
```

```json
{
  "command": "snapshot",
  "interactiveOnly": true,
  "depth": 2,
  "scope": "app",
  "raw": false
}
```

```json
{ "command": "recordStart", "outPath": "/tmp/demo.mp4", "fps": 30, "maxSize": 720 }
```

```json
{ "command": "rotate", "orientation": "landscape-left" }
```

The current command names are defined in:

- [`../../src/platforms/apple/core/runner/runner-client.ts`](../../src/platforms/apple/core/runner/runner-client.ts)
- [`AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTests+Models.swift`](AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTests+Models.swift)

## Response Shape

Successful and failed responses use the same top-level envelope:

```json
{
  "ok": true,
  "data": {
    "message": "ok"
  }
}
```

```json
{
  "ok": false,
  "error": {
    "code": "UNSUPPORTED_OPERATION",
    "message": "Unable to dismiss the iOS keyboard without a safe native dismiss control"
  }
}
```

`data` is command-specific. Common fields include snapshot nodes, text lookup results, gesture timing, visibility metadata, and screenshot or recording output details.

## Maintenance Rules

- Treat the TypeScript and Swift wire models as a single contract.
- When adding, removing, or renaming a command, update the protocol fixtures/tests in the same change.
- Keep this file focused on the actual wire shape rather than implementation details of command execution.
