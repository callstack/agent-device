---
title: Plugins
---

Provider plugins add device providers that agent-device does not bundle, such as [BrowserStack](/docs/browserstack), [AWS Device Farm](/docs/aws-device-farm), [Limrun](/docs/limrun), [TestMu AI](/docs/testmu), [LG webOS](/docs/webos), and [Samsung Tizen](/docs/tizen). Installing one requires npm on your host:

```bash
agent-device plugins add @example/agent-device-provider
agent-device plugins list --json
agent-device plugins update @example/agent-device-provider
agent-device plugins remove @example/agent-device-provider
```

`agent-device help connect` and `agent-device help remote` identify known optional providers as
`plugin, install separately` and show their installation commands, even before you install them.
Use the install command shown for your provider. TestMu AI uses `agent-device plugins add @agent-device/testmu`.

If you run `agent-device connect browserstack`, `agent-device connect aws-device-farm`, `agent-device connect limrun`, or `agent-device connect testmu` without its plugin, the error gives that installation
command and tells you to retry your original command. With `--json`, the error has
`details.reason: plugin-not-installed`, `details.package`, and `details.installCommand`.
If the plugin is selected but unavailable, the reason is `plugin-unavailable`; run
`agent-device plugins list --json` to inspect it, then fix its configuration or update the package.

Use a full npm package name, optionally with `@version` or `@tag`. `update` keeps valid version constraints and options, including when it repairs a damaged selection. To change a constraint, run `add <package>@<version-or-tag>`; to remove it, run `add <package>` without a suffix.

Each installation lives in an npm project with a lockfile under `AGENT_DEVICE_HOME` (default `~/.agent-device`), and that directory's `config.json` records the selection. Plugin commands leave other settings in `config.json` unchanged. Project config and `--config` cannot select plugins. This home is independent of `--state-dir` and `AGENT_DEVICE_STATE_DIR`.

Install only packages you trust: plugin factories run with the daemon's host permissions and environment. Installs skip lifecycle scripts, so packages must contain ready-to-run JavaScript and assets.

A failed install keeps the previous selection. A running daemon keeps the plugin set and files it started with, including removed installations. To apply changes, close sessions and run `agent-device daemon stop` with the matching `--state-dir`; the next device command uses the new set. Use separate state directories for different plugin homes.

## Install replay and test support

Install the native replay plugin on the daemon host.

```bash
agent-device plugins add @agent-device/replay
```

Finish your sessions and restart that daemon, then retry the original invocation with all its arguments. Native `.ad` scripts keep their syntax, variables, target verification, resume and repair behavior. Ordinary script recording stays in core.

A remote daemon needs its own installation. A local plugin store does not make an engine available remotely. An embedded host imports the factory from `@agent-device/replay/agent-device` and supplies `plugins: [replay()]` to `startAgentDevice`. Supplied plugins are authoritative; the embedded runtime does not read the store.

Maestro YAML replay requires `@agent-device/maestro` on both client and daemon hosts. Maestro suites also need `@agent-device/replay` on the daemon host. `replay export` needs the Maestro plugin on the client only.

A missing installation returns `plugin-not-installed` with the package and installation command. Selected package failures keep `plugin_load_failed`, `invalid_plugin`, `incompatible-plugin-api` or `plugin_setup_failed`; repair or update that selected package. `daemon-plugin-set-stale` requires restarting the daemon after sessions finish. For an embedded daemon, its host closes and recreates the runtime. No recovery installs packages or ends sessions automatically.

## See which providers are registered

`agent-device daemon status` lists every provider the running daemon registered from the installed plugins, such as BrowserStack, AWS Device Farm, and Limrun. With `--json`, each entry has:

```json
{
  "provider": "testmu",
  "source": "store",
  "package": "@agent-device/testmu",
  "version": "0.21.29",
  "state": "active",
  "credentials": { "variables": ["LT_USERNAME", "LT_ACCESS_KEY"], "byBackend": {} }
}
```

`source` is `builtin` or `store`; `embedder` is the third slot, reserved for plugins an embedding host passes itself (#3757). A plugin that cannot register has `state: "failed"` and an `error` with `code`, `message`, and a `reason` such as `invalid_plugin`, `incompatible_plugin`, or `duplicate_provider`. The daemon starts without it and keeps every other provider. Fix or remove the package, then stop the daemon so the next command starts a new one.

When a daemon's `daemon.json` cannot be used, `daemon status` says so instead of reporting a stopped daemon: `unreadable` means the file exists but could not be read, and `invalid` means it was read but is not a daemon record. A missing or stale record means `stopped`; an unreadable or invalid file never does.

When the daemon stops, it closes every plugin once: each runtime shuts down, then its `dispose` runs. A step that fails is logged as `provider_plugin_cleanup_failed` with the provider and step, and the other plugins still close.

`plugins list --json` works without a daemon. It lists your installed plugins with their provider and whether their factory loads and validates; whether `setup` succeeds shows only in a running daemon's inventory. When a daemon is running for the same `--state-dir`, it also reports that daemon's inventory under `daemon`.

When two plugins claim the same provider, the first one wins: bundled providers, then installed plugins in package-name order, then, once #3757 lets an embedding host pass plugins, those. The others are `failed` with `duplicate_provider`. The first claim holds even when that plugin then fails to set up, so a later plugin for the same provider doesn't take over. `cloud` and `proxy` are reserved and can't be claimed.

A lease that names a provider this daemon has no runtime for refuses with `UNSUPPORTED_OPERATION` and reason `provider-not-registered`, before any lease is recorded. The error lists the registered providers and, as `failedPlugins`, any plugin that failed to register for that provider (or failed before its provider was known); restart the daemon with the provider's plugin installed. Leases with no provider, `proxy`, and `cloud` need no provider runtime.

## Install Maestro support

`agent-device plugins add @agent-device/maestro` installs the optional Maestro engine for `replay --maestro`, `test --maestro`, and `replay export`. [Run Maestro flows](/docs/run-maestro-flows) explains client and daemon installation. `help maestro` remains available without the plugin.

Replay backends appear in plugin inventories with `backend` instead of `provider`. A daemon keeps its plugin set until it stops. Installing a package on a client does not change a remote or embedded daemon's plugin set.

## Create a plugin

The interface is experimental. A plugin package exports a factory at `./agent-device`. Use `agent-device` as a development dependency; plugins import only types from it.

```json
{
  "name": "@example/agent-device-provider",
  "type": "module",
  "engines": { "node": ">=22.12" },
  "agent-device": { "apiVersion": 3, "provider": "example" },
  "exports": {
    "./agent-device": { "import": "./dist/plugin.mjs" }
  }
}
```

```ts
import type { AgentDevicePluginFactory } from 'agent-device/plugins';

type ExampleOptions = { credentials?: { username: string; accessKey: string } };

const example: AgentDevicePluginFactory<ExampleOptions> = (options = {}) => ({
  apiVersion: 3,
  contributes: [
    {
      kind: 'provider',
      provider: 'example',
      credentials: {
        // Variables the daemon reads credentials from; none when the caller passes them as options.
        variables: options.credentials ? [] : ['EXAMPLE_USERNAME', 'EXAMPLE_ACCESS_KEY'],
      },
      setup: async (host) => ({ runtime, platformModule }),
    },
  ],
});

export default example;
```

The `agent-device` field in `package.json` declares the contract version and the static claims: `provider` and `replayBackend` name their id, and `replayExecution: true` claims native `ad` execution. Before any import, the host checks the package identity, that the resolved entry stays inside the package, the `apiVersion`, the Node floor from `engines.node`, and that each declared claim is unreserved. The first claim of a kind and id wins, and the claim holds even when that package then fails to load. After the factory runs with its options, the returned claims must equal the declared ones, in any order; a mismatch invalidates the package.

The factory is called with the package's `options` from `config.json` (`plugins["<package>"].options`; leave `installation` unchanged). A JavaScript host that imports the package calls the same factory directly with its own options.

The host resolves the `./agent-device` export with import conditions. It falls back to the package's root export only when that subpath does not exist. If the subpath exists but its import or `setup` throws, the plugin is reported as failed and the root export is not tried.

`setup(host)` receives `ProviderPluginHost`: `env`, `options`, `clientVersion`, and `createError` for host-recognized errors. Return one of:

- `{ runtime, platformModule, dispose? }` implementing the [provider runtime](https://github.com/callstack/agent-device/blob/main/packages/contracts/src/provider-device-runtime.ts) and [platform module](https://github.com/callstack/agent-device/blob/main/packages/contracts/src/platform-runtime-operations.ts) contracts. The runtime's `provider` and the module owner's `provider` must equal the plugin's `provider`, and the module owner must declare `kind: 'provider-runtime'` and a nonempty `instance`.
- `{ webDriver, dispose? }` for an Appium or WebDriver service. `WebDriverPluginOptions` is available through the type-only `agent-device/plugins/webdriver` import. The host supplies the client version and creates the shared runtime. Provider callbacks prepare sessions, upload apps, and retrieve artifacts.

The host checks required runtime methods and owner metadata when it sets the plugin up; operation contracts are checked when used. `dispose` runs once after the runtime shuts down. A failing `setup` cleans up its own resources; the host shuts down a runtime it already received if validation then refuses it.

Keep the factory and `setup` fast, with no network I/O or device allocation; a stalled plugin delays daemon startup. Load platform mechanics through `platformModule.loadRuntime` and perform remote work in request-bound operations.

Incompatible contract changes require a new `apiVersion`; there is no compatibility shim. `plugins add` and `plugins update` refuse a package whose `agent-device` field is missing or names another `apiVersion`, and a package already in the store is listed as `failed` with reason `incompatible-plugin-api`. Plugins can't replace bundled providers or register arbitrary commands.

### Credentials

List the environment variables the provider reads in `credentials.variables`. A local daemon keeps the values it started with; when the shell holds different ones, the first command that allocates a lease refuses with reason `provider-credentials-changed` until the daemon is stopped. The check treats a whitespace-only value as unset. If a lease reads fewer variables on one backend, narrow them with `credentials.byBackend`, for example `{ "android-instance": ["EXAMPLE_API_KEY"] }`. The Limrun plugin declares its account variables and each platform's instance variables this way, so a change to the iOS instance variables does not invalidate an Android lease. Credentials the caller passes as factory options are not in the environment, so list no variable for them.

### Connect

To support `agent-device connect example`, add a `connection` to the provider contribution:

```ts
contributes: [
  {
    kind: 'provider',
    provider: 'example',
    credentials: { variables: ['EXAMPLE_API_KEY'] },
    connection: {
      capabilities: {
        leaseKind: 'direct-device-provider',
        requiresAppAttachment: false,
        requiresRemoteDaemon: false,
        supportsArtifacts: false,
        supportsDeferredAppSelection: true,
        supportsDirectPortReverse: false,
        usesCloudWebDriverLease: false,
        holdsCloudDevice: false,
      },
      resolve: async ({ flags, env, cwd, stateDir, host }) => ({ profile }),
      verify: async ({ flags, env, host }) => verification,
    },
  },
],
```

`resolve` validates provider flags and returns `{ profile, extraFlags? }`; `profile.leaseProvider` must match the plugin's `provider`. The host supplies connection identity, session defaults, Metro settings, and persists the profile. `verify` returns the provider verification result. Both also receive `host`, the same `ProviderPluginHost` that `setup` gets, built from the `env` of that call. Both run without allocating a device or setting up a runtime. `agent-device` loads installed plugins' factories, not their `setup`, to read these capabilities. Set the optional `holdsCloudDevice: true` when the provider leases a cloud-hosted device. Each command that uses the lease then requests a five-minute lease window, the same as a proxy or cloud WebDriver lease, not the 60-second daemon default. A daemon whose `AGENT_DEVICE_LEASE_MAX_TTL_MS` is below five minutes refuses that request with `INVALID_ARGS`.

### Package for installation

Bundle the plugin implementation and ship ready-to-run ESM: installation disables lifecycle scripts. Bundle shared helpers with the plugin; `AppError` carries a shared brand so the host preserves its code and details across package copies. Import types with `import type` to keep them out of the runtime dependency graph. A published plugin package names `./agent-device` in its `exports`: that is the subpath the host's loader and the publish checks read, so don't ship a plugin only through the root export or `main`.

## Migrating from the version 2 contract

Version 2 returned `{ apiVersion: 2, provider, credentials, connection?, setup }` from the factory. Version 3 wraps each contribution in `contributes` and declares the static claims in the package's `agent-device` field. There is no compatibility shim: `plugins add` and `plugins update` refuse a version 2 package, and one already in the store is listed as `failed` with reason `incompatible-plugin-api`.

To move a package:

1. Return `apiVersion: 3` with `contributes: [{ kind: 'provider', provider, credentials, connection?, setup }]`; the default export stays a function the host calls with the selection's options.
2. Add `"agent-device": { "apiVersion": 3, "provider": "example" }` and `"engines": { "node": ">=22.12" }` to `package.json`, with the same claims the factory returns.
3. A replay plugin's `setup` now receives only `clientVersion` and `createError`, not the version 2 host with `env`, `options` and `runHostCommand`. A replay backend moves its host-command work into the lazy `replayBackend.create(host)`, whose host offers `runCommand`. A replay execution's `execution.create()` receives no host.

```diff
 export default () => ({
-  apiVersion: 2,
-  provider: 'example',
-  credentials: { variables: ['EXAMPLE_API_KEY'] },
-  setup: async (host) => ({ runtime, platformModule }),
+  apiVersion: 3,
+  contributes: [{
+    kind: 'provider',
+    provider: 'example',
+    credentials: { variables: ['EXAMPLE_API_KEY'] },
+    setup: async (host) => ({ runtime, platformModule }),
+  }],
 });
```

```diff
+{"engines": {"node": ">=22.12"}, "agent-device": {"apiVersion": 3, "provider": "example"}}
```

A plugin object with an `apiVersion` other than 3 is listed as `failed` with `incompatible-plugin-api`, and a default export that is not a plugin factory with `invalid_plugin`; the daemon starts without either.

## Create a replay plugin

A replay plugin uses the same managed `./agent-device` factory entry and `apiVersion: 3`. Return a declaration whose `contributes` lists the replay kind: `replay-backend` for a format backend such as `maestro`, or `replay-execution` with `id: 'ad'` for native replay and test. Declare the claim statically in `package.json` as `"agent-device": { "apiVersion": 3, "replayBackend": "maestro" }` or `{ "apiVersion": 3, "replayExecution": true }`. Keep setup engine-free; `create` may asynchronously import the engine when a replay capability is selected.

```ts
{
  apiVersion: 3,
  contributes: [
    {
      kind: 'replay-backend',
      backend: 'maestro',
      setup: (host) => ({ replayBackend: { create(host) }, dispose? }),
    },
  ],
}
```

Replay setup receives the `ReplaySetupHost`: only `clientVersion` and `createError`. For a format backend, setup returns `{ replayBackend: { create(host) }, dispose? }`. The backend implements source collection, source inspection, replay execution, and export. Its `ReplayBackendHost` supplies dispatch-related services and request cancellation; each replay command supplies its host environment, session access, and `invoke`.

For the native `replay-execution` contribution (`id: 'ad'`), setup returns `{ execution: { create() }, dispose? }`. The object returned by `create()` implements `inspectAdReplay`, `runAdReplay`, and `runReplayTestSuite`. The id `ad` is reserved: a `replay-backend` contribution cannot claim it. Return only the factory for your kind: the host rejects a native setup that provides `replayBackend`, or a format setup that provides `execution`.

The daemon owns sessions, policy, selector/ref authority, and device cleanup. `dispose` runs once after requests drain. Client-side source collection and export dispose their scoped plugin registry when the operation ends.


## Install a local plugin artifact

On each host that needs the plugin, install its `.tgz` file. Use `./` or `../` for a relative path, or provide an absolute path:

```sh
agent-device plugins add ./provider-plugin.tgz --json
agent-device plugins list --json
```

The archive must contain an npm package with a name, an exact version, and an `./agent-device` export. Installation does not run package lifecycle scripts or load the plugin factory. The list command loads the factory to check compatibility. The installation returns an `artifact` receipt with compatibility marked `unchecked`. Run `plugins list --json` for the checked `plugins` inventory, including the artifact's installation ID and SHA-512 integrity. If the package is already selected, remove it before adding the artifact. `plugins update` does not update artifacts from the registry; remove the selection and add the replacement artifact. Finish active sessions and restart the daemon after changing the selection.

A Node.js host can call the same manager with an explicit environment and working directory:

```js
import { addPluginArtifact } from 'agent-device/plugins';
await addPluginArtifact('./provider-plugin.tgz', { env: process.env, cwd: process.cwd() });
```
