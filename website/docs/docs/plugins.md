# Provider plugins

Provider plugins add device providers that agent-device does not bundle, such as [TestMu AI](/docs/testmu). Installing one requires npm on your host:

```bash
agent-device plugins add @example/agent-device-provider
agent-device plugins list --json
agent-device plugins update @example/agent-device-provider
agent-device plugins remove @example/agent-device-provider
```

`agent-device help connect` and `agent-device help remote` identify known optional providers as
`plugin, install separately` and show their installation commands, even before you install them.
For example, TestMu AI requires `agent-device plugins add @agent-device/testmu`.

If you run `agent-device connect testmu` without its plugin, the error gives that installation
command and tells you to retry your original command. With `--json`, the error has
`details.reason: plugin-not-installed`, `details.package`, and `details.installCommand`.
If the plugin is selected but unavailable, the reason is `plugin-unavailable`; run
`agent-device plugins list --json` to inspect it, then fix its configuration or update the package.

Use a full npm package name, optionally with `@version` or `@tag`. `update` keeps valid version constraints and options, including when it repairs a damaged selection. To change a constraint, run `add <package>@<version-or-tag>`; to remove it, run `add <package>` without a suffix.

Each installation lives in an npm project with a lockfile under `AGENT_DEVICE_HOME` (default `~/.agent-device`), and that directory's `config.json` records the selection. Plugin commands leave other settings in `config.json` unchanged. Project config and `--config` cannot select plugins. This home is independent of `--state-dir` and `AGENT_DEVICE_STATE_DIR`.

Install only packages you trust: plugin factories run with the daemon's host permissions and environment. Installs skip lifecycle scripts, so packages must contain ready-to-run JavaScript and assets.

A failed install keeps the previous selection. A running daemon keeps the plugin set and files it started with, including removed installations. To apply changes, close sessions and run `agent-device daemon stop` with the matching `--state-dir`; the next device command uses the new set. Use separate state directories for different plugin homes.

## See which providers are registered

`agent-device daemon status` lists every provider the running daemon registered: the bundled ones (BrowserStack, AWS Device Farm, and Limrun when it is configured), then installed plugins. With `--json`, each entry has:

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

## Create a plugin

The interface is experimental. A plugin package exports a factory at `./agent-device`. Use `agent-device` as a development dependency; plugins import only types from it.

```json
{
  "name": "@example/agent-device-provider",
  "type": "module",
  "exports": {
    "./agent-device": { "import": "./dist/plugin.mjs" }
  }
}
```

```ts
import type { AgentDevicePluginFactory } from 'agent-device/plugins';

type ExampleOptions = { credentials?: { username: string; accessKey: string } };

const example: AgentDevicePluginFactory<ExampleOptions> = (options = {}) => ({
  apiVersion: 2,
  provider: 'example',
  credentials: {
    // Variables the daemon reads credentials from; none when the caller passes them as options.
    variables: options.credentials ? [] : ['EXAMPLE_USERNAME', 'EXAMPLE_ACCESS_KEY'],
  },
  setup: async (host) => ({ runtime, platformModule }),
});

export default example;
```

The factory is called with the package's `options` from `config.json` (`plugins["<package>"].options`; leave `installation` unchanged). A JavaScript host that imports the package calls the same factory directly with its own options.

The host resolves the `./agent-device` export with import conditions. It falls back to the package's root export only when that subpath does not exist. If the subpath exists but its import or `setup` throws, the plugin is reported as failed and the root export is not tried.

`setup(host)` receives `ProviderPluginHost`: `env`, `options`, `clientVersion`, and `createError` for host-recognized errors. Return one of:

- `{ runtime, platformModule, dispose? }` implementing the [provider runtime](https://github.com/callstack/agent-device/blob/main/packages/contracts/src/provider-device-runtime.ts) and [platform module](https://github.com/callstack/agent-device/blob/main/packages/contracts/src/platform-runtime-operations.ts) contracts. The runtime's `provider` and the module owner's `provider` must equal the plugin's `provider`, and the module owner must declare `kind: 'provider-runtime'` and a nonempty `instance`.
- `{ webDriver, dispose? }` for an Appium or WebDriver service. `WebDriverPluginOptions` is available through the type-only `agent-device/plugins/webdriver` import. The host supplies the client version and creates the shared runtime. Provider callbacks prepare sessions, upload apps, and retrieve artifacts.

The host checks required runtime methods and owner metadata when it sets the plugin up; operation contracts are checked when used. `dispose` runs once after the runtime shuts down. A failing `setup` cleans up its own resources; the host shuts down a runtime it already received if validation then refuses it.

Keep the factory and `setup` fast, with no network I/O or device allocation; a stalled plugin delays daemon startup. Load platform mechanics through `platformModule.loadRuntime` and perform remote work in request-bound operations.

Incompatible contract changes require a new `apiVersion`. Plugins can't replace bundled providers or register arbitrary commands.

### Credentials

List the environment variables the provider reads in `credentials.variables`. A local daemon keeps the values it started with; when the shell holds different ones, the first command that allocates a lease refuses with reason `provider-credentials-changed` until the daemon is stopped. The check treats a whitespace-only value as unset. If a lease reads fewer variables on one backend, narrow them with `credentials.byBackend`, for example `{ "android-instance": ["EXAMPLE_API_KEY"] }`. Credentials the caller passes as factory options are not in the environment, so list no variable for them.

### Connect

To support `agent-device connect example`, add a `connection` to the plugin:

```ts
connection: {
  capabilities: {
    leaseKind: 'direct-device-provider',
    requiresAppAttachment: false,
    requiresRemoteDaemon: false,
    supportsArtifacts: false,
    supportsDeferredAppSelection: true,
    supportsDirectPortReverse: false,
    usesCloudWebDriverLease: false,
  },
  resolve: async ({ flags, env, cwd, stateDir, host }) => ({ profile }),
  verify: async ({ flags, env, host }) => verification,
},
```

`resolve` validates provider flags and returns `{ profile, extraFlags? }`; `profile.leaseProvider` must match the plugin's `provider`. The host supplies connection identity, session defaults, Metro settings, and persists the profile. `verify` returns the provider verification result. Both also receive `host`, the same `ProviderPluginHost` that `setup` gets, built from the `env` of that call. Both run without allocating a device or setting up a runtime. `agent-device` loads installed plugins' factories, not their `setup`, to read these capabilities.

### Package for installation

Bundle the plugin implementation and ship ready-to-run ESM: installation disables lifecycle scripts. Bundle shared helpers with the plugin; `AppError` carries a shared brand so the host preserves its code and details across package copies. Import types with `import type` to keep them out of the runtime dependency graph.

## Version 1 plugins

Packages that declare `agentDevicePlugin` with `apiVersion: 1` in `package.json` keep working. The host reads the manifest's `provider`, `entry`, `connection`, and `credentialVariables` before running any plugin code, then calls the default export with `ProviderPluginHost` and registers the `{ runtime, platformModule }` or `{ webDriver, connection? }` it returns. Support for this form ends in a later release; move to the `./agent-device` factory.

```json
{"agentDevicePlugin": {"apiVersion": 1, "provider": "example", "entry": "./dist/plugin.mjs"}}
```

A package that exports `./agent-device` is loaded as a version 2 plugin even if it also keeps the manifest, so one package can serve both old and new hosts.
