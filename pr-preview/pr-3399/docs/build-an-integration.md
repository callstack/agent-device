# Build an integration

This page is for developers who build a bridge, remote daemon, device-cloud backend, or in-process runner on top of agent-device. These entry points let your server own device access, command dispatch, or Metro while reusing agent-device's behavior.

To drive devices from your own Node.js code, use the [Node.js API](/agent-device/pr-preview/pr-3399/docs/client-api.md) instead.

## Runnable examples

The repository includes [runnable, typechecked examples](https://github.com/callstack/agent-device/tree/main/examples/sdk) for these entry points:

| Example                                                                                                             | Demonstrates                                              |
| ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| [`batch-orchestration.ts`](https://github.com/callstack/agent-device/blob/main/examples/sdk/batch-orchestration.ts) | Run a batch through a custom transport                    |
| [`metro-runtime.ts`](https://github.com/callstack/agent-device/blob/main/examples/sdk/metro-runtime.ts)             | Normalize a Metro URL and resolve runtime transport hints |

Build the package with `pnpm build`, then run an example with Node:

```bash
node --experimental-strip-types examples/sdk/metro-runtime.ts
```

## API reference

Entry points for integrations:

- `agent-device/android-adb`
  - `createAndroidPortReverseManager(provider)` / `createAndroidPortReverseManager(executor, { noRebind })`
  - `captureAndroidLogcatWithAdb(executor, options?)`
  - `readAndroidClipboardWithAdb(executor)` / `writeAndroidClipboardWithAdb(executor, text)`
  - `getAndroidKeyboardStatusWithAdb(executor)` / `dismissAndroidKeyboardWithAdb(executor)`
  - `openAndroidAppWithAdb(executor, packageName)`
  - `forceStopAndroidAppWithAdb(executor, packageName)`
  - `listAndroidAppsWithAdb(executor)`
  - `getAndroidAppStateWithAdb(executor)`
  - types: `AndroidAdbExecutor`, `AndroidAdbExecutorOptions`, `AndroidAdbProvider`,
    `AndroidKeyboardState`, `AndroidKeyboardDismissResult`, `AndroidPortReverseEndpoint`
- `agent-device/batch`
  - `runBatch(req, sessionName, invoke)`
- `agent-device/remote-config`
  - `resolveRemoteConfigProfile(options)`
  - types: `RemoteConfigProfile`
- `agent-device/metro`
  - `buildBundleUrl(baseUrl, platform)`
  - `normalizeBaseUrl(baseUrl)`
  - `resolveRuntimeTransport(runtime)`
  - `prepareMetroRuntime(options?)`, `reloadMetro(options?)`, `stopMetroTunnel(options)`
  - types: `MetroBridgeDescriptor`, `MetroTunnelRequestMessage`, `MetroTunnelResponseMessage`
- `agent-device/contracts`
  - `centerOfRect(rect)`
  - `defaultHintForCode(code)`, `normalizeError(error)`
  - types: `DaemonError`, `DaemonInstallSource`, `DaemonRequest`, `DaemonResponse`, `DaemonResponseData`, `JsonRpcId`, `JsonRpcRequestEnvelope`, `LeaseBackend`, `SessionRuntimeHints`
- `agent-device/selectors`
  - `parseSelectorChain(expression)`
  - `tryParseSelectorChain(expression)`
  - `resolveSelectorChain(nodes, chain, options)`
  - `findSelectorChainMatch(nodes, chain, options)`
  - `listSelectorChainMatches(nodes, chain, options)`
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
  - `isTrustedInstallSourceUrl(sourceUrl)` (deprecated; install sources are not gated on it)
  - `validateDownloadSourceUrl(url)`
  - types: `MaterializeInstallSource`
- `agent-device/artifacts`
  - `resolveAndroidArchivePackageName(archivePath)`
- `agent-device/limrun`
  - `new LimrunRuntime(options)`
  - `runtime.getDeviceSession(device)`
  - types: `LimrunRuntimeOptions`, `LimrunDeviceSession`, `LimrunAndroidDeviceSession`,
    `LimrunIosDeviceSession`, `LimrunIosCommandExecution`
- `agent-device/plugins/webdriver`
  - experimental `WebDriverPluginOptions` for providers using the shared engine.
- `agent-device/plugins`
  - experimental factory context: `ProviderPluginHost`; see [provider plugins](/agent-device/pr-preview/pr-3399/docs/plugins.md).

## Android ADB providers

Use `agent-device/android-adb` when your bridge owns Android device access and you want
agent-device's behavior for ADB operations. Executors receive the arguments that follow `adb`, so a
remote bridge can route the same argument arrays through an ADB tunnel, websocket API, or another
remote transport.

The helpers take an executor directly. Use `captureAndroidLogcatWithAdb(executor, options?)` for a
bounded logcat capture.

A provider can also expose `reverse` to own port reversal. Plain executors do not advertise reverse
support; call `createAndroidPortReverseManager(providerOrExecutor)`
only when the provider supports `adb reverse` argument semantics. The manager makes duplicate setup
idempotent for the same owner and rejects conflicting owners for the same local endpoint. For a
device that other adb clients also drive, pass an executor with `{ noRebind: true }`: the manager
runs `adb reverse --no-rebind` and never replaces an existing device mapping, including one it
created. When `adb reverse --list` shows the mapping, the refusal fails with `COMMAND_FAILED` and
`details.reason: 'android_port_reverse_rebind_refused'`. Otherwise it fails as an ordinary adb error.

The device shell re-parses whatever follows `shell` or `exec-out`, so those commands are built for you:
every dynamic word is rendered for the quoting its transport applies before it reaches the device. `adb`
forwards words verbatim, so a word is single-quoted; `hdc` wraps each element it sends in double quotes,
where `$`, a backquote, and `"` stay live, so a word is escaped for that context instead. An array that
begins with `shell` or `exec-out` and did not come from those builders is refused with `INVALID_ARGS` and
`details.reason: 'unguarded-device-shell-argv'` instead of being dispatched. A bridge that composes its
own device commands calls `runAdbShell(executor, words, options?)` or
`runAdbExecOut(executor, words, options?)` from `agent-device/android-adb`, passing each value as its
own word; `runAndroidShell(device, words, options?)` and `runAndroidExecOut(device, words, options?)`
resolve the executor from a device instead.

```ts
import { getAndroidAppStateWithAdb, listAndroidAppsWithAdb } from 'agent-device/android-adb';
import type { AndroidAdbExecutorOptions } from 'agent-device/android-adb';

const provider = {
  exec: async (args: readonly string[], options?: AndroidAdbExecutorOptions) =>
    await runAdbThroughRemoteTunnel(args, options),
};

const apps = await listAndroidAppsWithAdb(provider.exec); // user-installed apps by default
const foreground = await getAndroidAppStateWithAdb(provider.exec);
```

## Batch orchestration for custom transports

Use `agent-device/batch` when a bridge or in-process runner receives daemon-shaped requests but owns command dispatch itself. The helper applies the same validation, inherited flags, serial execution, partial results, and error envelopes as the daemon `batch` command.

Full example from [`examples/sdk/batch-orchestration.ts`](https://github.com/callstack/agent-device/blob/main/examples/sdk/batch-orchestration.ts):

```ts file="<root>/../examples/sdk/batch-orchestration.ts"
/**
 * Batch orchestration for a custom transport: `runBatch` keeps step
 * validation, inherited flags, serial execution, partial results, and
 * daemon-shaped error envelopes aligned with the CLI's `batch` command, so a
 * bridge that owns command dispatch itself does not have to reimplement them.
 *
 * Demonstrates: `runBatch` from `agent-device/batch`, consumed against the
 * `DaemonResponse` result type from `agent-device/contracts`.
 *
 * Prerequisites: none — `dispatch` below is a stub; a real integration would
 * replace it with a call into the bridge's own command dispatcher.
 *
 * Run: node --experimental-strip-types examples/sdk/batch-orchestration.ts
 */
import { runBatch } from 'agent-device/batch';
import type { DaemonResponse } from 'agent-device/contracts';

type BatchRequest = Parameters<typeof runBatch>[0];

async function dispatch(stepReq: unknown): Promise<Record<string, unknown>> {
  console.log('dispatching step', stepReq);
  return { handled: true };
}

function bridgeErrorToDaemonResponse(error: unknown): Extract<DaemonResponse, { ok: false }> {
  return {
    ok: false,
    error: {
      code: 'COMMAND_FAILED',
      message: error instanceof Error ? error.message : 'Unknown bridge error',
    },
  };
}

async function handleBatch(req: BatchRequest): Promise<DaemonResponse> {
  return await runBatch(req, req.session ?? 'default', async (stepReq) => {
    try {
      return { ok: true, data: await dispatch(stepReq) };
    } catch (error) {
      return bridgeErrorToDaemonResponse(error);
    }
  });
}

const result = await handleBatch({
  command: 'batch',
  positionals: [],
  flags: {
    batchSteps: [
      { command: 'wait', input: { text: 'Welcome' } },
      { command: 'back', input: {} },
    ],
  },
});

if (result.ok) {
  console.log(`batch completed: ${JSON.stringify(result.data)}`);
} else {
  console.error(`batch failed [${result.error.code}]: ${result.error.message}`);
  process.exitCode = 1;
}

```

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

Use `agent-device/selectors` to parse and match selector expressions in a remote daemon or bridge. The `role=` term matches the platform-neutral `kind` vocabulary that `snapshot --json` publishes (see [Snapshots](/agent-device/pr-preview/pr-3399/docs/snapshots.md#structured-node-fields---json)): pass the nodes as captured, and a node whose `kind` is `text` always matches `role=text`. Separately, pre-reconciliation leaf spellings (`statictext`, `edittext`, `textview`, …) still match during a deprecation window, each on the nodes that actually carried that class. A legacy spelling matches beside such a node's `kind`, not in place of it — `role=webarea` resolves a macOS-helper `AXWebArea` node whose `kind` is `axwebarea`, for example. Matching stays platform-aware because editability checks differ by backend.

`listSelectorChainMatches(nodes, chain, options)` returns every node the winning selector alternative matches, in snapshot order, plus that alternative and its index — the same first-match domain `findSelectorChainMatch` uses, without uniqueness refusal, so a runner applies its own strictness to the same nodes the CLI matched. `resolveSelectorChain` can name a later alternative: by default it refuses an ambiguous one and keeps walking, so the indices agree when it passes `requireUnique: false`, when the first matching alternative is unique, or when `disambiguateAmbiguous: true` resolves that alternative in place. It returns `null` when no alternative matches. `options` is `{ platform, requireRect? }`; the matched `SnapshotNode` objects are the ones passed in.

```ts
import { findSelectorChainMatch, parseSelectorChain } from 'agent-device/selectors';

const chain = parseSelectorChain('role=button label="Continue" visible=true');

const match = findSelectorChainMatch(snapshot.nodes, chain, {
  platform: 'android',
  requireRect: true,
});

if (!match) {
  // Build a daemon-shaped error with formatSelectorFailure(...) if needed.
}
```
