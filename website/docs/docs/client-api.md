---
title: Node.js API
---

# Node.js API

This page is for developers who drive devices from their own Node.js code. Use `createAgentDeviceClient()` for typed, deterministic device automation instead of shelling out to the CLI.

Building an agent? Start with the dedicated [AI SDK](/docs/ai-sdk) or [Eve](/docs/eve) integration. Building a bridge, remote daemon, or device-cloud backend that owns device access or command dispatch? See [Build an integration](/docs/build-an-integration).

## Runnable examples

The repository includes [runnable, typechecked Node.js examples](https://github.com/callstack/agent-device/tree/main/examples/sdk). They import the same published `agent-device/*` entry points your code uses:

| Example | Demonstrates |
| --- | --- |
| [`client-session.ts`](https://github.com/callstack/agent-device/blob/main/examples/sdk/client-session.ts) | Open, snapshot, interact, handle typed errors, and always close the session |
| [`contracts-result.ts`](https://github.com/callstack/agent-device/blob/main/examples/sdk/contracts-result.ts) | Consume snapshot results with helpers from [`agent-device/contracts`](/docs/build-an-integration#api-reference) |

Examples for custom transports and Metro are on [Build an integration](/docs/build-an-integration#runnable-examples).

Each example typechecks against the SDK through its own [`tsconfig.json`](https://github.com/callstack/agent-device/blob/main/examples/sdk/tsconfig.json). Build the package with `pnpm build`, then run an example with Node:

```bash
node --experimental-strip-types examples/sdk/client-session.ts
```

## API reference

Entry points for driving devices from Node.js:

- `agent-device`
  - `createAgentDeviceClient(options?)`
  - `startAgentDevice(options)`
  - types: `AgentDeviceHost`, `StartAgentDeviceOptions`
  - `ensureDaemon(options?)`
  - `createLocalArtifactAdapter(options?)`
  - `AppError`, `isAgentDeviceError(error)`, `normalizeAgentDeviceError(error)`
  - `isUnreadableCaptureContentError(error)`: true when an Android helper capture found no readable
    app content yet (`empty-helper-output`, `system-window-only`, `content-poor-app-window`), for
    example while the app is still loading. Polling callers may keep polling. False for every other
    platform, backend, and mechanism failure.
  - `centerOfRect(rect)`
  - types: `AgentDeviceClient`, `AgentDeviceClientConfig`, `AgentDeviceDevice`
  - types: `DaemonBinding`, `DaemonLifecycle`, `EnsureDaemonOptions`, `DaemonConnection`, `DaemonIdentity`
  - types: every option and result type of the client's methods, among them `AppOpenOptions`,
    `AppOpenResult`, `CaptureSnapshotOptions`, `CaptureSnapshotResult`, `CaptureScreenshotResult`,
    `PressOptions`
  - types: `SnapshotNode`, `RawSnapshotNode`, `SnapshotState`, `Rect`, `Point`
  - types: `NormalizedError`, `AppErrorCode`, `KnownAppErrorCode`, `AppErrorDetails`, `ErrorCause`
- `agent-device/io`
  - `createLocalArtifactAdapter(options?)`
  - types: `ArtifactAdapter`, `ArtifactDescriptor`, `CreateTempFileOptions`, `FileInputRef`,
    `FileOutputRef`, `LocalArtifactAdapterOptions`, `OutputVisibility`, `ReserveOutputOptions`,
    `ReservedOutputFile`, `ResolveInputOptions`, `ResolvedInputFile`, `TemporaryFile`
- `agent-device/ai-sdk`
  - `createAgentDeviceTools(options)`
  - types: `AgentDeviceToolSet`, `AgentDeviceTools`, `CreateAgentDeviceToolsOptions`

## Basic usage

This example opens an app, takes a snapshot, interacts, handles typed errors, and always closes the session. Run it from [`examples/sdk/client-session.ts`](https://github.com/callstack/agent-device/blob/main/examples/sdk/client-session.ts).

```ts file="<root>/../examples/sdk/client-session.ts"
```

`client.devices.capabilities()` returns `{ device, availableCommands }`, using the same capability matrix as the CLI. Use it to check which command names the selected target supports.

For direct iOS simulator app launches, `client.apps.open({ app, platform: 'ios', launchConsole: './artifacts/app.console.log' })` captures launch-time
stdout/stderr. The option mirrors `open --launch-console` and is not valid for URL opens or non-simulator targets.

`client.sessions.stateDir()` mirrors `session state-dir` and returns the resolved daemon state directory without starting
or contacting the daemon. Pass `{ stateDir }` to resolve an explicit override the same way the CLI resolves `--state-dir`.

`client.sessions.artifacts({ provider, providerSessionId })` mirrors `artifacts --provider ... --provider-session ...` and returns provider-hosted `cloudArtifacts`.
Use it for BrowserStack, AWS Device Farm, or TestMu AI session videos/logs after a cloud session has stopped; `client.sessions.close()` returns the ID as `closed.provider?.providerSessionId`. Omit `providerSessionId` when an embedding host has registered a provider runtime that can infer the active lease. Limrun does not expose provider artifacts through this command.

```ts
const result = await client.sessions.artifacts({
  provider: 'aws-device-farm',
  providerSessionId: 'arn:aws:devicefarm:us-west-2:123:session/project/session/00000',
});

if ('cloudArtifacts' in result) {
  for (const artifact of result.cloudArtifacts) {
    console.log(artifact.kind, artifact.name, artifact.url);
  }
}
```

## Daemon lifecycle

A client talks to one local daemon per state directory. `daemonLifecycle` says who owns that daemon.

A host-owned daemon ends through its host's own close or an authenticated shutdown request over its registered local transport. Clients never signal the host. A `'managed'` client reuses a matching host-owned daemon. Takeover, drain, and timeout recovery ask the central retirement, which judges the record's owner once: a live host-owned or unrecognized owner is refused without a signal, while a record whose owner provably exited is retired like any abandoned one, so the state directory stays usable. `agent-device daemon stop --state-dir <path>` sends the shutdown request and waits for the close report. It can also ask a readable record with unrecognized ownership: an embedded runtime can close itself, but a detached answer fails with `daemon-not-embedded` and a record-repair hint, without signaling. A host's direct close also records its result, so stops already waiting can confirm a clean release.

For these shutdown requests, stop fails with `daemon-embedded-stop-unreachable` when the record lacks usable transport or token, `daemon-shutdown-unconfirmed` when the close cannot be confirmed (including after connection failure), or, without `--clean`, `daemon-record-unreadable` when `daemon.json` cannot be read. These are `error.details.reason` values. A retained close returns `stopped: true`, warnings and `cleanupConfidence: 'unknown'` with exit 0: the runtime stopped serving, but resource cleanup is unconfirmed. Later stops can read that retained answer while the same host holds the registration.

| Mode | What the client does with the daemon |
| --- | --- |
| `'managed'` (default) | Starts a missing daemon, replaces one that does not match the client, and retires an unresponsive one after a timeout. |
| `'attach'` | Connects to the running daemon. Never starts, replaces or stops one, even after a timeout. |

`'managed'` stays the default until 0.22. Use `'attach'` when your code, or another process, owns the daemon, and call `ensureDaemon()` to start or replace it deliberately:

```ts
import { createAgentDeviceClient, ensureDaemon } from 'agent-device';

const stateDir = './.my-app/agent-device-state';

await ensureDaemon({
  stateDir,
  onStart: (reason, previous) => console.log(`started a daemon: ${reason}`, previous),
});
const client = createAgentDeviceClient({ stateDir, daemonLifecycle: 'attach' });
```

`ensureDaemon()` starts a daemon when none runs. It replaces a daemon that does not match the client only if that daemon holds no work: no request in flight, no session, no repair session and no live lease. A resumable upload still streaming and a host human-control hold that names no lease are not counted, so a replacement can end them. Otherwise it fails and leaves the daemon alone. Two cases retire a daemon without that proof, because it cannot be asked: a registered daemon that answers nothing on any transport, and one that times out on the quiesce request and then fails repeated liveness probes. A daemon that accepted the quiesce request is never signaled while it drains: the call waits up to 60 s for it to exit and clear its registration. One still running after that fails repeated liveness probes and is force-retired when its process is provably a daemon. A daemon that still answers, or whose process cannot be proven to be a daemon, fails the call with `daemon-drain-timeout`; a force retirement that cannot be confirmed fails it with `daemon_retirement_unconfirmed`. It returns `{ stateDir, daemon, started }`; `daemon` holds the pid, version and code identity, and no credentials. `onStart` runs when the call started a daemon: `'incompatible'` when it replaced a daemon that agreed to leave, with that daemon as `previous`, and `'missing'` otherwise. A `'missing'` start that also has a `previous` replaced a registered daemon that answered nothing, or one that accepted the request to leave and was force-retired after outlasting its drain.

These failures carry a typed `error.details.reason`:

| Reason | Meaning |
| --- | --- |
| `daemon-not-running` | An `'attach'` client found no daemon to connect to. Call `ensureDaemon()`. |
| `daemon-incompatible` | The running daemon does not match the client. `details.daemon` and `details.client` hold both identities. Stop it with `agent-device daemon stop --state-dir <path>`, then call `ensureDaemon()`. A daemon from a release that predates quiescing cannot be asked to leave, so `ensureDaemon()` reports it the same way. |
| `daemon-busy` | `ensureDaemon()` found an incompatible daemon that still holds work. `details` counts `inFlightRequests`, `sessions`, `repairSessions` and `leases`. Wait for them to end and retry. |
| `daemon-drain-timeout` | A daemon accepted the request to leave but was still running 60 s later and could not be force-retired, either because it still answers or because its process cannot be proven to be a daemon (an embedded host). It was not signaled. Retry once it has exited, or stop it with `agent-device daemon stop --state-dir <path>`. |
| `daemon-owner-embedded` | A host process owns the daemon on `stateDir`, so this client neither replaced it nor retired it, and signaled nothing. A daemon that matches the client is still usable. Close that host, or stop it with `agent-device daemon stop --state-dir <path>`. |
| `daemon-owner-unrecognized` | The record on `stateDir` states an owner this version cannot read, so this client replaced nothing and signaled nothing. Update agent-device if the record comes from a newer build. Otherwise check what owns that process: a host that started it closes it with its own close, and otherwise remove `daemon.json` once that process is gone. |
| `daemon-binding-mismatch` | A client pinned to one daemon instance reached another one instead. `details.mismatch` says which: `replaced`, `absent`, or `unaddressable`. Nothing was dispatched, started, or signaled. Take a fresh config from the host that owns the daemon, or start a host of your own. |

`ensureDaemon()` only ever manages the local daemon on `stateDir`. A client with `daemonBaseUrl` never starts or stops a local daemon in either mode, and `daemonLifecycle` does not change `daemonTransport` or `daemonServerMode`.

## Running the daemon inside your process

`startAgentDevice()` starts the daemon inside your own process and returns a client for it. Use it when you want the daemon's lifetime to be exactly your process's, or when you import plugin objects you already have.

```ts
import { startAgentDevice } from 'agent-device';

const host = await startAgentDevice({
  stateDir: './.my-app/agent-device-state',
});

const devices = await host.client.devices.list();
await host.close();
```

`stateDir` is required. If another daemon owns it, startup refuses with `daemon_registration_refused`; choose a separate directory or close its owner first. Pass imported plugin objects in `plugins`. They register after the built-ins without reading the plugin store, so `plugin add` does not change a running host. Plugin failures appear in `agent-device daemon status --state-dir <path>`. `close()` reports unfinished teardown. Repeated calls share one close, including after an operator stops the runtime, and never exit your process.

The runtime stays alive until you close it or send `agent-device daemon stop --state-dir <path>`; idle reaping is disabled. `daemon stop --clean` is refused because cleanup must stay within this runtime. If the shutdown report lists abandoned requests or unfinished cleanup, inspect those outcomes before reusing the state directory: the runtime may retain its registration to protect work still in progress.

`host.clientConfig` is serializable JSON: pass it to another process or worker and build an attach client from it. The client must pass normal version and code compatibility checks, then match the pinned instance. An incompatible or replacement daemon is refused:

```ts
import { createAgentDeviceClient, startAgentDevice } from 'agent-device';

const host = await startAgentDevice({ stateDir: './.my-app/agent-device-state' });
// Hand the config to a worker or another process: it is plain JSON, no build step.
const client = createAgentDeviceClient(host.clientConfig);
```

A client can also pin one instance on its own with `daemonBinding: { token, pid, processStartTime }`. Every request then goes to that instance and authenticates with its token. The client never starts, replaces, retires or redirects a daemon to satisfy the pin, so a state directory that registers any other instance is refused with `details.reason: 'daemon-binding-mismatch'`, and so is one that registers none or holds a record it cannot read as an address. The pin holds the daemon's token, so treat it as a credential: share it only with trusted processes that should control this runtime.

## Device cloud sessions

You drive Limrun, BrowserStack, AWS Device Farm, and TestMu AI devices with the same typed client methods. Use the CLI `connect` flow to persist connection state locally. Pass provider settings in the client config when your Node.js integration already owns credentials and provider selectors.

```ts
import { createAgentDeviceClient } from 'agent-device';

const client = createAgentDeviceClient({
  leaseProvider: 'browserstack',
  providerOsVersion: '14.0',
  providerApp: 'bs://app-id',
  // Optional hosted device features, applied when the session is created.
  providerDeviceOrientation: 'portrait',
  providerTimezone: 'New_York',
});

await client.apps.open({ app: 'com.example.app', platform: 'android', device: 'Google Pixel 8' });
await client.capture.snapshot({ interactiveOnly: true });
const closed = await client.sessions.close();
```

`apps.open` also returns a response-level `selection` record describing whether the target came
from an explicit selector, an existing session, one local booted/bootable candidate, the one booted
simulator with the app installed, or one provider-owned candidate. Ambiguous requests fail with
structured retry selectors instead of silently retargeting.

To fetch provider-hosted video and log URLs after close, pass `closed.provider?.providerSessionId` to [`client.sessions.artifacts()`](#basic-usage). See the [BrowserStack](/docs/browserstack), [AWS Device Farm](/docs/aws-device-farm), [TestMu AI](/docs/testmu), and [Limrun](/docs/limrun) guides for provider-specific setup.

## Web sessions

Pass `platform: 'web'` to drive a browser session with the same command methods. Web automation
requires Node 24+. No client method sets up the managed web backend: run `agent-device web setup`
before first use, in the same state directory the client uses. Run `agent-device web doctor` to check
backend health.

```ts
await client.apps.open({ url: 'https://example.com', platform: 'web' });
await client.capture.snapshot({ platform: 'web', interactiveOnly: true });
await client.interactions.fill({ platform: 'web', ref: '@e12', text: 'test@example.com' });
await client.command.wait({ platform: 'web', text: 'Welcome' });
await client.observability.network({ platform: 'web', include: 'headers' });
await client.observability.audio({
  platform: 'web',
  action: 'probe',
  probeAction: 'start',
  durationMs: 10_000,
  bucketMs: 1_000,
});
await client.sessions.close();
```

MCP tools use the same command contracts, so they can also target `platform: 'web'` after setup;
setup and doctor stay CLI-only. Web network inspection returns the standard network result shape
without request or response bodies.


## Command methods

Use `client.command.<method>()` for command-level device actions. These calls go through the same daemon transport as the higher-level client methods, so they carry session metadata and tenant/run/lease fields, return normalized daemon errors, and handle remote artifacts.

Results are daemon-shaped objects with typed known fields and follow the CLI's command semantics.

A failed interaction rejects with the same error the CLI prints. Read `error.details.dispatched` before you retry; [Retry after a failed command](/docs/commands#retry-after-a-failed-command) explains the values.

Every client call that dispatches to the daemon accepts `signal?: AbortSignal` to cancel that one call:

```ts
const controller = new AbortController();
await client.interactions.press({ ref: '@e12', signal: controller.signal });
```

With the built-in transport, a signal that is already aborted rejects the call without sending anything (`error.details.dispatched: 'no'`). Aborting while the request is in flight closes that request's connection, the daemon marks the request canceled, and the promise rejects with the typed canceled-request error (`error.details.reason: 'request_canceled'`, `error.details.dispatched: 'unknown'`). A custom transport receives the signal on its context and may cancel differently. The daemon and the session stay alive for other requests. On iOS, a command that already reached the device keeps running there, so the daemon holds the session while the device reports it running. Your promise still rejects at once. The hold ends when the device reports the command finished, when the command's own timeout runs out, or when the device cannot confirm the command (it never received it, or the status check fails). Only in the first case is the canceled work known to be over before the session's next request starts. An abort is not a timeout: it never triggers the runner cleanup or daemon reset that a timeout does. Cancellation covers only the daemon request, so a response-artifact download already underway is not stopped, and a canceled one-shot replay still runs the existing cleanup that can tear down a daemon this client started.

```ts
await client.command.wait({
  text: 'Continue',
  timeoutMs: 5_000,
});

await client.command.keyboard({
  action: 'dismiss',
});

await client.command.clipboard({
  action: 'write',
  text: 'hello from Node',
});

await client.command.back({
  mode: 'system',
});

await client.command.tvRemote({
  platform: 'android',
  target: 'tv',
  button: 'down',
});

await client.command.tvRemote({
  platform: 'ios',
  target: 'tv',
  button: 'select',
});

await client.command.tvRemote({
  platform: 'vega',
  target: 'tv',
  serial: 'VirtualDevice',
  button: 'select',
  durationMs: 900,
});

await client.command.appSwitcher();
await client.command.actionButton();
await client.command.fold({ pose: 'open' });
await client.command.telephony({ action: 'call', number: '5551234' });
await client.command.telephony({ action: 'sms', number: '5551234', text: 'Your code is 1234' });
await client.command.fold({
  keyframes: [
    { atMs: 0, angle: 0 },
    { atMs: 1667, angle: 160 },
    { atMs: 3333, angle: 100 },
    { atMs: 5000, angle: 180 },
  ],
});
```

`fold` accepts either `pose` or `keyframes`. Keyframes use linear interpolation at roughly 60 updates per second; repeat an angle to hold it. Timestamps must start at zero and increase strictly, with 2–64 frames and a final timestamp no greater than 60,000ms. Angles must be finite and between 0° and 180°. The final timestamp bounds motion, excluding helper preparation and final hinge verification. A custom final angle is verified within 0.5°; interior angles must also settle. Cancellation stops the motion at its current angle. Re-snapshot afterwards, including after interrupted motion. Android emulators accept `pose` only.

`press`, `click`, and `longpress` do not wait for a missing target to appear. When a screen is still loading, wait for its landmark before interacting:

```ts
await client.command.wait({ text: 'Continue', timeoutMs: 5_000 });
await client.interactions.press({ selector: 'label="Continue"' });
```

If the wait times out, check the selector and app state with a fresh snapshot. A covered, off-screen, or ambiguous target still fails the interaction.

Vega OS client support is VVD-only and covers device discovery, app open/close, `back`, `home`, and `tvRemote`. Physical Fire TV, capture, selector, install, logging, and performance methods report unsupported for Vega targets.

Supported command methods:

- `wait`
- `alert`
- `appState`
- `back`
- `home`
- `orientation`
- `appSwitcher`
- `actionButton`
- `fold`
- `telephony`
- `keyboard`
- `clipboard`
- `tvRemote`
- `reactNative`
- `doctor`
- `prepare`
- `viewport`

`rotate()` is a deprecated alias for `orientation()`; use `orientation()`.

Domain client methods:

- `client.devices.list()`, `capabilities()`, `boot()`, `shutdown()`
- `client.sessions.list()`, `stateDir()`, `close()`, `saveScript()`, `artifacts()`
- `client.apps.install()`, `reinstall()`, `uninstall()`, `installFromSource()`, `list()`, `open()`, `close()`, `push()`, `triggerEvent()`
- `client.materializations.release()`
- `client.leases.allocate()`, `heartbeat()`, `release()`. Pass `retainOnClose: true` to `allocate()` when you release the lease yourself; session `close` then leaves it active until `release()`, expiry, or daemon shutdown. The returned lease has `retainOnClose: true` only when the daemon honored it. Keep heartbeating a retained lease between sessions: it expires after its `ttlMs` like any other lease. Pass `leaseId` (16 to 128 hex characters) to `allocate()` to name a new lease with an id the daemon has never issued, or to get back your live lease with that id when you retry with the same tenant, run, client, lease backend, and provider (and no device, or the leased one), then use the returned `leaseId`: a run that already holds a lease gets that one back, and an older daemon mints its own. `allocate()` with a `leaseProvider` the daemon has no runtime for fails with `UNSUPPORTED_OPERATION`, reason `provider-not-registered`, and `details.registeredProviders`; no lease is recorded. Leases with no provider, `proxy`, or `cloud` need no runtime.
- `client.metro.prepare()`, `reload()`
- `client.capture.snapshot()`, `screenshot()`, `diff()`
- `client.interactions.click()`, `press()`, `longPress()`, `swipe()`, `pan()`, `drag()`, `fling()`, `swipeGesture()`, `focus()`, `type()`, `fill()`, `scroll()`, `pinch()`, `rotateGesture()`, `transformGesture()`, `tapGesture()`, `get()`, `is()`, `find()`
- `client.replay.run()` and `client.replay.test()`
- `client.batch.run()`
- `client.observability.perf(options)`, `logs()`, `events()`, `network()`, and `audio()`
- `client.debug.symbols()`
- `client.recording.record()` and `client.recording.trace()`
- `client.settings.update()`

If the daemon returns a missing or non-object lease, or a lease without a non-empty string for `leaseId`, `tenantId`, `runId`, or `backend`, `client.leases.allocate()` and `client.leases.heartbeat()` reject with `COMMAND_FAILED` and `details.reason: "INVALID_LEASE_RESPONSE"`.
The original daemon response is available in `error.details.response`.

`client.devices.list()` returns `AgentDeviceDevice` entries. Their optional `model` and `osVersion` fields describe the hardware and OS when discovery reports them; see [Device discovery](/docs/commands#device-discovery) for the sources.

`client.capture.snapshot()` carries an optional `viewport: { width, height }` beside `nodes`: the box those rects are measured in, in the same coordinate space and orientation. Scale and clip against it instead of inferring the screen from the largest rect. When no box was measured, the field is absent rather than zero; see [Coordinates and viewport](/docs/snapshots#coordinates-and-viewport) for what each producer answers with.

It also carries an optional `presentedSurface: 'presented' | 'absent' | 'unknown'` on iOS captures: whether the capture saw a modal presentation over your app's content. `'absent'` is a reading that was earned, so it is safe to act on; `'unknown'` says the capture could not tell and is not `'absent'`. The field is absent on other platforms. See [Presented surface](/docs/snapshots#presented-surface).

`client.observability.events({ cursor, limit })` reads the session event timeline as paged JSON entries. Use `nextCursor` from the previous page to continue from the daemon-owned `events.ndjson` file without replaying already uploaded/displayed events. Cursors are absolute and survive the file's size rotation; a cursor older than the retained window rejects with `COMMAND_FAILED`, `details.reason: "EVENT_LOG_CURSOR_EXPIRED"`, and `details.earliestCursor` to resume from.
The timeline leaves out user-entered content such as typed text, selector values, and payloads; see [Sessions](/docs/sessions#find-a-sessions-logs-and-artifacts) for what it keeps.

`client.observability.audio()` mirrors `audio probe start|status|stop`. Use it to collect compact RMS/peak dBFS buckets while other session actions continue:

```ts
await client.observability.audio({
  platform: 'web',
  action: 'probe',
  probeAction: 'start',
  durationMs: 10_000,
  bucketMs: 1_000,
});
await client.interactions.click({ platform: 'web', ref: '@e4' });
const audio = await client.observability.audio({
  platform: 'web',
  action: 'probe',
  probeAction: 'status',
});
await client.observability.audio({ platform: 'web', action: 'probe', probeAction: 'stop' });
```

Pass `platform: 'web'`, `'macos'`, `'ios'` (simulators), or `'android'` (emulators on macOS hosts). See [Audio probes](/docs/debugging-profiling#audio-probes) for what each platform samples, permissions, and unsupported targets.

`client.observability.perf()` requires an options object with an explicit `area`; a call without one fails with an error that names the replacement. The option shapes mirror the `perf` CLI forms:

- Frame health: `{ area: 'frames' }`
- Memory: `{ area: 'memory', action: 'sample' }`, or `{ area: 'memory', action: 'snapshot', kind: 'android-hprof' | 'memgraph', out }` to write an artifact to disk
- CPU profile: `{ area: 'cpu', subject: 'profile', action: 'start' | 'stop' | 'report', kind: 'xctrace' | 'simpleperf', out }`
- Trace: `{ area: 'trace', action: 'start' | 'stop', kind: 'perfetto' | 'xctrace', out }`

To start an xctrace capture, also pass a `template` such as `'Time Profiler'` or `'Animation Hitches'`.

On Android, each successful `perf({ area: 'frames' })` read and each `open` of an app resets the frame window, so call it, perform a transition or gesture, then call it again to inspect that window. See [Performance snapshots](/docs/debugging-profiling#performance-snapshots) for result fields and platform support.

`client.recording.record({ action: 'start', path, quality: 'medium' })` starts a recording with medium output quality.

`client.capture.screenshot({ path, scale: 0.3 })` captures a screenshot at 30% of its original width and height. `scale` accepts `0.01` through `1`.

`client.batch.run({ steps })` accepts structured steps:
`{ command: 'open', input: { app: 'settings' } }`. Step `input` uses the same fields as the
matching client command. Daemon-shaped `positionals`/`flags` steps are internal to the daemon and not
part of the client API. To run daemon-shaped batches through your own dispatcher, see
[Batch orchestration for custom transports](/docs/build-an-integration#batch-orchestration-for-custom-transports).

## Android `installFromSource()`

```ts
import { createAgentDeviceClient } from 'agent-device';

const androidClient = createAgentDeviceClient({ session: 'qa-android' });

const installed = await androidClient.apps.installFromSource({
  platform: 'android',
  retainPaths: true,
  retentionMs: 60_000,
  source: { kind: 'url', url: 'https://example.com/app.apk' },
});

await androidClient.apps.open({
  platform: 'android',
  app: installed.launchTarget,
});

console.log(installed.packageName, installed.launchTarget);

if (installed.materializationId) {
  await androidClient.materializations.release({
    materializationId: installed.materializationId,
  });
}

await androidClient.sessions.close();
```

On Android, a successful `installFromSource()` response includes the identity you need to relaunch the app:

- `packageName`
- `launchTarget`

If the daemon cannot determine the installed app's identity, the request fails instead of returning an empty success payload.

## URL source rules

`installFromSource()` limits URL sources:

- Private and loopback hosts are blocked by default.
- URL sources from any public host may point directly to an installable, including a bare iOS `.ipa`, or to a `.zip`, `.tar`, `.tar.gz`, or `.tgz` archive containing exactly one.
- For existing reachable artifact URLs, use `source: { kind: 'url', url: ... }`.
- For local artifacts, use `source: { kind: 'path', path: ... }` or the CLI `install`/`reinstall` commands.
- When a remote daemon resolves CI artifacts server-side, pass a GitHub Actions artifact source:

```ts
await client.apps.installFromSource({
  platform: 'android',
  source: {
    kind: 'github-actions-artifact',
    owner: 'acme',
    repo: 'mobile',
    artifactId: 1234567890,
  },
});
```

Remote daemons may also support `{ kind: 'github-actions-artifact', owner, repo, artifactName }` or `{ kind: 'github-actions-artifact', owner, repo, runId, artifactName }`. The local client passes these payloads through unchanged; it does not authenticate with GitHub or download the artifact.

Android `.apk` and `.aab` URL sources resolve package identity from the downloaded install artifact. Archive URLs may contain one installable `.apk`, `.aab`, `.ipa`, or iOS `.app`, including inside nested archives.
