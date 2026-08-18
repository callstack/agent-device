---
title: Node.js API
---

# Node.js API

Use `createAgentDeviceClient()` to give a Node.js agent typed access to device automation instead of shelling out to the CLI. Its methods can be exposed as model tools, called from deterministic orchestration code, or combined with another Node.js agent framework.

Start with the [AI SDK](/docs/ai-sdk) or [Eve](/docs/eve) integration guide for complete tool-calling examples. The client is framework-neutral, so the same pattern works with other solutions that accept JavaScript or TypeScript functions as tools.

## Runnable examples

The repository includes [runnable, typechecked Node.js examples](https://github.com/callstack/agent-device/tree/main/examples/sdk) that import the same published `agent-device/*` entry points used by consumers:

| Example | Demonstrates |
| --- | --- |
| [`client-session.ts`](https://github.com/callstack/agent-device/blob/main/examples/sdk/client-session.ts) | Open, snapshot, interact, handle typed errors, and always close the session |
| [`contracts-result.ts`](https://github.com/callstack/agent-device/blob/main/examples/sdk/contracts-result.ts) | Consume snapshot results with helpers from `agent-device/contracts` |
| [`batch-orchestration.ts`](https://github.com/callstack/agent-device/blob/main/examples/sdk/batch-orchestration.ts) | Run a batch through a custom transport |
| [`metro-runtime.ts`](https://github.com/callstack/agent-device/blob/main/examples/sdk/metro-runtime.ts) | Normalize a Metro URL and resolve runtime transport hints |

The examples are checked against the source SDK using their dedicated [`tsconfig.json`](https://github.com/callstack/agent-device/blob/main/examples/sdk/tsconfig.json). After building the package with `pnpm build`, run an example directly with Node:

```bash
node --experimental-strip-types examples/sdk/client-session.ts
```

## API reference

Supported public entry points for Node consumers:

- `agent-device`
  - `createAgentDeviceClient(options?)`
  - `createLocalArtifactAdapter(options?)`
  - `AppError`, `isAgentDeviceError(error)`, `normalizeAgentDeviceError(error)`
  - `centerOfRect(rect)`
- `agent-device/io`
  - `createLocalArtifactAdapter(options?)`
  - types: `ArtifactAdapter`, `ArtifactDescriptor`, `CreateTempFileOptions`, `FileInputRef`,
    `FileOutputRef`, `LocalArtifactAdapterOptions`, `OutputVisibility`, `ReserveOutputOptions`,
    `ReservedOutputFile`, `ResolveInputOptions`, `ResolvedInputFile`, `TemporaryFile`
- `agent-device/metro`
  - `buildBundleUrl(baseUrl, platform)`
  - `normalizeBaseUrl(baseUrl)`
  - `resolveRuntimeTransport(runtime)`
  - `prepareMetroRuntime(options?)`, `reloadMetro(options?)`, `stopMetroTunnel(options)`
  - types: `MetroBridgeDescriptor`, `MetroTunnelRequestMessage`, `MetroTunnelResponseMessage`
- `agent-device/batch`
  - `runBatch(req, sessionName, invoke)`
- `agent-device/remote-config`
  - `resolveRemoteConfigProfile(options)`
  - types: `RemoteConfigProfile`
- `agent-device/contracts`
  - `centerOfRect(rect)`
  - `defaultHintForCode(code)`, `normalizeError(error)`
  - types: `DaemonError`, `DaemonInstallSource`, `DaemonRequest`, `DaemonResponse`, `DaemonResponseData`, `JsonRpcId`, `JsonRpcRequestEnvelope`, `LeaseBackend`, `SessionRuntimeHints`
- `agent-device/selectors`
  - `parseSelectorChain(expression)`
  - `tryParseSelectorChain(expression)`
  - `resolveSelectorChain(nodes, chain, options)`
  - `findSelectorChainMatch(nodes, chain, options)`
  - `formatSelectorFailure(chain, diagnostics, options)`
  - `isNodeVisible(node)`
  - `isSelectorToken(token)`
  - `isNodeEditable(node, platform)`
  - types: `SelectorChain`, `SelectorDiagnostics`
- `agent-device/finders`
  - `findBestMatchesByLocator(nodes, locator, query, requireRectOrOptions)`
  - `parseFindArgs(args)`
  - types: `FindMatchOptions`
- `agent-device/install-source`
  - `ARCHIVE_EXTENSIONS`
  - `isTrustedInstallSourceUrl(sourceUrl)`
  - `validateDownloadSourceUrl(url)`
  - types: `MaterializeInstallSource`
- `agent-device/artifacts`
  - `resolveAndroidArchivePackageName(archivePath)`
- `agent-device/android-adb`
  - `createAndroidPortReverseManager(provider)`
  - `captureAndroidLogcatWithAdb(executor, options?)`
  - `readAndroidClipboardWithAdb(executor)` / `writeAndroidClipboardWithAdb(executor, text)`
  - `getAndroidKeyboardStatusWithAdb(executor)` / `dismissAndroidKeyboardWithAdb(executor)`
  - `openAndroidAppWithAdb(executor, packageName)`
  - `forceStopAndroidAppWithAdb(executor, packageName)`
  - `listAndroidAppsWithAdb(executor)`
  - `getAndroidAppStateWithAdb(executor)`
  - types: `AndroidAdbExecutor`, `AndroidAdbExecutorOptions`, `AndroidAdbProvider`,
    `AndroidKeyboardState`, `AndroidKeyboardDismissResult`, `AndroidPortReverseEndpoint`
- `agent-device/limrun`
  - `new LimrunRuntime(options)`
  - `runtime.getDeviceSession(device)`
  - types: `LimrunRuntimeOptions`, `LimrunDeviceSession`, `LimrunAndroidDeviceSession`,
    `LimrunIosDeviceSession`, `LimrunIosCommandExecution`
- `agent-device/ai-sdk`
  - `createAgentDeviceTools(options)`
  - types: `AgentDeviceToolSet`, `AgentDeviceTools`, `CreateAgentDeviceToolsOptions`

## Basic usage

The canonical client example is embedded below. It is also runnable from [`examples/sdk/client-session.ts`](https://github.com/callstack/agent-device/blob/main/examples/sdk/client-session.ts).

```ts file="<root>/../examples/sdk/client-session.ts"
```

`client.devices.capabilities()` returns `{ device, availableCommands }`, using the same capability matrix as the CLI. Use it when a dynamic integration needs to decide which command names are valid for the selected target.

For direct iOS simulator app launches, `client.apps.open({ app, platform: 'ios', launchConsole: './artifacts/app.console.log' })` captures launch-time
stdout/stderr. The option mirrors `open --launch-console` and is not valid for URL opens or non-simulator targets.

When surfacing Apple simulators, `client.apps.open({ deviceHub: true })` mirrors `open --device-hub` and uses Xcode Device Hub instead of the
standalone Simulator app.

`client.sessions.stateDir()` mirrors `session state-dir` and returns the resolved daemon state directory as a pure local resolution — it never starts
or contacts the daemon. Pass `{ stateDir }` to resolve an explicit override the same way the CLI resolves `--state-dir`.

`client.sessions.artifacts({ provider, providerSessionId })` mirrors `artifacts --provider ... --provider-session ...` and returns provider-hosted `cloudArtifacts`.
Use it for BrowserStack or AWS Device Farm session videos/logs after a cloud session has stopped, or omit `providerSessionId` when an embedding host has registered a provider runtime that can infer the active lease. Limrun does not currently expose provider artifacts through this command.

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

## Device cloud sessions

Limrun, BrowserStack, and AWS Device Farm can be driven through the normal typed client methods. Use the corresponding CLI `connect` flow when you want persisted local connection state. Use direct client config when a Node integration already owns credentials and provider selectors.

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

Use `client.sessions.artifacts({ provider, providerSessionId })` with `closed.provider?.providerSessionId` to fetch provider-hosted video and log URLs after close. See the [BrowserStack](/docs/browserstack), [AWS Device Farm](/docs/aws-device-farm), and [Limrun](/docs/limrun) guides for provider-specific setup.

## Web sessions

Typed client commands can target browser sessions with the same command methods by passing
`platform: 'web'`. The managed web backend is set up through the CLI, not through a typed client
method, so run `agent-device web setup` before first use in the same effective state directory. Use
`agent-device web doctor` when you need to verify backend health.

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

Web automation requires Node 24+. MCP tools use the same command contracts, so they can target
`platform: 'web'` after setup, but local setup/doctor remains a CLI-only workflow. Web network
inspection adapts managed `agent-browser` request history to the existing network result shape;
request and response bodies are not exposed by that backend path. Web audio probes sample HTML
media elements and return compact dBFS buckets.

## Android ADB providers

Use `agent-device/android-adb` when a bridge owns Android device access but wants upstream command
behavior for ADB-shaped operations. Executors receive arguments after `adb`, so remote bridges can
route the same argument arrays through an ADB tunnel, websocket API, or another remote transport.

The public helpers accept an executor directly and do not expose the daemon's scoped adb
interception internals. Use `captureAndroidLogcatWithAdb(executor, options?)` when a bridge needs a
bounded logcat capture.

Providers can also expose `reverse` for first-class port reverse ownership. Plain executors do not
advertise reverse support automatically; call `createAndroidPortReverseManager(providerOrExecutor)`
only when the provider supports `adb reverse` argument semantics. The manager makes duplicate setup
idempotent for the same owner and rejects conflicting owners for the same local endpoint.

```ts
import { getAndroidAppStateWithAdb, listAndroidAppsWithAdb } from 'agent-device/android-adb';
import type { AndroidAdbExecutorOptions } from 'agent-device/android-adb';

const provider = {
  exec: async (args: string[], options?: AndroidAdbExecutorOptions) =>
    await runAdbThroughRemoteTunnel(args, options),
};

const apps = await listAndroidAppsWithAdb(provider.exec); // user-installed apps by default
const foreground = await getAndroidAppStateWithAdb(provider.exec);
```

## Command methods

Use `client.command.<method>()` for command-level device actions. It uses the same daemon transport path as the higher-level client methods, including session metadata, tenant/run/lease fields, normalized daemon errors, and remote artifact handling.

Results are daemon-shaped objects with typed known fields, so command semantics stay aligned with the CLI.

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
```

Vega OS client support is currently VVD-only and covers device discovery, app open/close, `back`, `home`, and `tvRemote`. Physical Fire TV, capture, selector, install, logging, and performance methods report unsupported for Vega targets.

Supported command methods:

- `wait`
- `alert`
- `appState`
- `back`
- `home`
- `orientation`
- `appSwitcher`
- `keyboard`
- `clipboard`
- `tvRemote`
- `reactNative`
- `doctor`
- `prepare`
- `viewport`

The deprecated `rotate()` alias remains available for compatibility; use `orientation()` in new integrations.

The complete domain-client method map is:

- `client.devices.list()`, `capabilities()`, `boot()`, `shutdown()`
- `client.sessions.list()`, `stateDir()`, `close()`, `saveScript()`, `artifacts()`
- `client.apps.install()`, `reinstall()`, `installFromSource()`, `list()`, `open()`, `close()`, `push()`, `triggerEvent()`
- `client.materializations.release()`
- `client.leases.allocate()`, `heartbeat()`, `release()`
- `client.metro.prepare()`, `reload()`
- `client.capture.snapshot()`, `screenshot()`, `diff()`
- `client.interactions.click()`, `press()`, `longPress()`, `swipe()`, `pan()`, `drag()`, `fling()`, `swipeGesture()`, `focus()`, `type()`, `fill()`, `scroll()`, `pinch()`, `rotateGesture()`, `transformGesture()`, `get()`, `is()`, `find()`
- `client.replay.run()` and `client.replay.test()`
- `client.batch.run()`
- `client.observability.perf()`, `logs()`, `events()`, `network()`, and `audio()`
- `client.debug.symbols()`
- `client.recording.record()` and `client.recording.trace()`
- `client.settings.update()`

`client.observability.events({ cursor, limit })` reads the session event timeline as paged JSON entries. Use `nextCursor` from the previous page to continue from the daemon-owned `events.ndjson` file without replaying already uploaded/displayed events. Cursors are absolute and survive the file's size rotation; a cursor older than the retained window rejects with `COMMAND_FAILED`, `details.reason: "EVENT_LOG_CURSOR_EXPIRED"`, and `details.earliestCursor` to resume from.
The event timeline keeps operational context such as command/status/timing, paths, session/device/app identifiers, refs/selectors, and coordinates. Typed text, clipboard writes, push/event payloads, raw unknown command arguments, and matching raw message fragments are replaced with length-only placeholders.

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

Web probes sample HTML media elements. Host-system probes use `platform: 'macos'`, `platform: 'ios'` for iOS simulators, or `platform: 'android'` for Android emulators on macOS hosts. They sample host system audio through ScreenCaptureKit and require Screen Recording permission. Physical iOS and Android app audio are not exposed by this command.

Prefer an explicit area with `client.observability.perf()` so each request stays focused. Calling `perf()` without options or using `area: 'metrics'` remains a deprecated compatibility path until the next major release; on Android, that path retains the released `dumpsys cpuinfo` point sample. Pass `{ area: 'frames' }` for a bounded frame/jank-health payload or `{ area: 'memory', action: 'sample' }` for a compact memory-only sample. Use `{ area: 'memory', action: 'snapshot', kind: 'android-hprof', out: 'app.hprof' }` on Android or `{ area: 'memory', action: 'snapshot', kind: 'memgraph', out: 'app.memgraph' }` on supported Apple simulator/macOS app sessions to write large memory artifacts to disk. Android native artifacts use `{ area: 'cpu', subject: 'profile', action: 'start' | 'stop' | 'report', kind: 'simpleperf', out }` and `{ area: 'trace', action: 'start' | 'stop', kind: 'perfetto', out }`; CPU reports return at most ten top functions in data and print five, while trace/profile contents remain on disk. Physical iOS device memgraph capture reports unavailable with a reason/hint. On Android and supported Apple targets, `data.metrics.fps.droppedFramePercent` is the primary frame-smoothness value. Android derives it from the current `adb shell dumpsys gfxinfo <package> framestats` window; connected iOS devices derive it from `xcrun xctrace` Animation Hitches for the active app process. Frame samples include `windowStartedAt`, `windowEndedAt`, and `worstWindows` so agents can correlate dropped-frame clusters with logs, network entries, and their own session actions. A successful Android read resets Android frame stats; `open <app>` resets the Android frame window too, so agents can call `perf({ area: 'frames' })`, perform a transition or gesture, then call it again to inspect that focused window. iOS simulator and macOS app sessions report frame health as unavailable rather than inventing FPS or dropped-frame values.

For Apple native profiling, call `perf({ area: 'cpu', subject: 'profile', action: 'start', kind: 'xctrace', template: 'Time Profiler', out: 'app.trace' })`, then stop with the same trace path and write a compact report with `action: 'report'`. The CPU report includes a bounded weighted top-function summary; the raw trace remains an artifact. `area: 'trace'` supports xctrace templates such as `Animation Hitches`.

`client.recording.record({ action: 'start', path, quality: 'medium' })` starts a recording with medium output quality.

`client.capture.screenshot({ path, scale: 0.3 })` captures a screenshot at 30% of its original width and height. `scale` accepts `0.01` through `1`.

`client.batch.run({ steps })` accepts structured steps:
`{ command: 'open', input: { app: 'settings' } }`. Step `input` uses the same fields as the
matching client command; daemon-shaped `positionals`/`flags` steps are internal to the daemon batch
executor.

## Batch orchestration for custom transports

Use `agent-device/batch` when a bridge or in-process runner receives daemon-shaped requests but owns command dispatch itself. The helper keeps validation, inherited flags, serial execution, partial results, and error envelopes aligned with the daemon batch command.

The standalone custom-transport example is embedded below from [`examples/sdk/batch-orchestration.ts`](https://github.com/callstack/agent-device/blob/main/examples/sdk/batch-orchestration.ts).

```ts file="<root>/../examples/sdk/batch-orchestration.ts"
```

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

On Android, a successful `installFromSource()` response returns enough app identity to relaunch the installed app:

- `packageName`
- `launchTarget`

If the daemon cannot determine installed app identity, the request fails instead of returning an empty success payload.

## URL source rules

`installFromSource()` URL sources are intentionally limited:

- Private and loopback hosts are blocked by default.
- Archive-backed URL installs are only supported for trusted artifact services, currently GitHub Actions and EAS.
- For existing reachable artifact URLs, use `source: { kind: 'url', url: ... }`.
- For local artifacts, use `source: { kind: 'path', path: ... }` or the CLI `install`/`reinstall` commands.
- For compatible remote daemons that resolve CI artifacts server-side, pass a GitHub Actions artifact source:

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

Remote daemons may also support `{ kind: 'github-actions-artifact', owner, repo, artifactName }` or `{ kind: 'github-actions-artifact', owner, repo, runId, artifactName }`. The local client preserves these payloads and does not perform GitHub authentication or artifact download.

Direct Android `.apk` and `.aab` URL sources can still resolve package identity from the downloaded install artifact. Trusted GitHub Actions and EAS archive URLs may contain one installable `.apk`, `.aab`, `.ipa`, or iOS `.app` tar archive.

## Remote Metro helpers

```ts
import { prepareMetroRuntime, reloadMetro, stopMetroTunnel } from 'agent-device/metro';
import { resolveRemoteConfigProfile } from 'agent-device/remote-config';

const remoteConfig = resolveRemoteConfigProfile({
  configPath: './agent-device.remote.json',
  cwd: process.cwd(),
});

const prepared = await prepareMetroRuntime({
  projectRoot: remoteConfig.profile.metroProjectRoot!,
  kind: remoteConfig.profile.metroKind ?? 'auto',
  proxyBaseUrl: remoteConfig.profile.metroProxyBaseUrl,
  proxyBearerToken: remoteConfig.profile.metroBearerToken,
  bridgeScope: {
    tenantId: remoteConfig.profile.tenant!,
    runId: remoteConfig.profile.runId!,
    leaseId: remoteConfig.profile.leaseId!,
  },
  companionProfileKey: remoteConfig.resolvedPath,
});

console.log(prepared.iosRuntime, prepared.androidRuntime);

await reloadMetro({
  runtime: prepared.iosRuntime,
});

await stopMetroTunnel({
  projectRoot: remoteConfig.profile.metroProjectRoot!,
  profileKey: remoteConfig.resolvedPath,
});
```

Use `agent-device/remote-config` for profile loading and path resolution, `agent-device/metro` for Metro preparation, reload, and tunnel lifecycle, and `agent-device/contracts` when a server consumer needs daemon request or runtime contract types. For bridged remote Metro, `proxyBaseUrl` is the bridge origin and `publicBaseUrl` is optional; the bridge descriptor supplies cloud iOS wildcard HTTPS hints and Android runtime-route hints. `reloadMetro()` calls Metro's `/reload` endpoint, matching the terminal `r` reload path for connected React Native apps.

## Selector helpers

Use `agent-device/selectors` when a remote daemon or bridge needs to parse and match selector expressions without deep-importing daemon internals. Matching is platform-aware because role normalization and editability checks differ by backend.

```ts
import { findSelectorChainMatch, parseSelectorChain } from 'agent-device/selectors';

const chain = parseSelectorChain('role=button label="Continue" visible=true');

const match = findSelectorChainMatch(snapshot.nodes, chain, {
  platform: 'android',
  requireRect: true,
});

if (!match) {
  // Build a daemon-shaped error with formatSelectorFailure(...) if needed.
