# Provider plugins

Provider plugins add device providers that agent-device does not bundle, such as [TestMu AI](/docs/testmu). Installing one requires npm on your host:

```bash
agent-device plugins add @example/agent-device-provider
agent-device plugins list --json
agent-device plugins update @example/agent-device-provider
agent-device plugins remove @example/agent-device-provider
```

Use a full npm package name, optionally with `@version` or `@tag`. `update` keeps valid version constraints and options, including when it repairs a damaged selection. To change a constraint, run `add <package>@<version-or-tag>`; to remove it, run `add <package>` without a suffix.

Each installation lives in an npm project with a lockfile under `AGENT_DEVICE_HOME` (default `~/.agent-device`), and that directory's `config.json` records the selection. Plugin commands leave other settings in `config.json` unchanged. Project config and `--config` cannot select plugins. This home is independent of `--state-dir` and `AGENT_DEVICE_STATE_DIR`.

Install only packages you trust: plugin factories run with the daemon's host permissions and environment. Installs skip lifecycle scripts, so packages must contain ready-to-run JavaScript and assets.

A failed install keeps the previous selection. A running daemon keeps the plugin set and files it started with, including removed installations. To apply changes, close sessions and run `agent-device daemon stop` with the matching `--state-dir`; the next device command uses the new set. Use separate state directories for different plugin homes.

Compatibility checks run offline against local metadata; provider operations may still need network access. An incompatible plugin stops the daemon from starting. Run `plugins list --json` to see the errors, then update or remove the affected package. Upgrading agent-device does not download compatible plugin versions for you.

## Create a plugin

The interface is experimental. Publish this declaration in your package manifest:

```json
{"agentDevicePlugin": {"apiVersion": 1, "provider": "example", "entry": "./dist/plugin.mjs"}}
```

Use `agent-device` as a development dependency. The default factory accepts `ProviderPluginHost` from `agent-device/plugins`: `env`, package-specific `options`, `clientVersion`, and `createError` for host-recognized errors. Return `{ runtime, platformModule }` implementing the [provider runtime](https://github.com/callstack/agent-device/blob/main/packages/contracts/src/provider-device-runtime.ts) and [platform module](https://github.com/callstack/agent-device/blob/main/packages/contracts/src/platform-runtime-operations.ts) contracts. Both provider IDs must match the manifest; the module owner must declare `kind: 'provider-runtime'` and a nonempty `instance`. Core checks required runtime methods and owner metadata at startup; operation contracts are checked when used. Provider packages own implementation types; the SDK exposes only factory context. Set options through `plugins["<package>"].options` in user config; leave `installation` unchanged.

Keep the factory fast, with no network I/O or device allocation; a stalled factory blocks daemon startup. Load platform mechanics through `platformModule.loadRuntime` and perform remote work in request-bound operations. A failing factory cleans up its own resources; core shuts down previously returned runtimes if another plugin fails.

Incompatible contract changes require a new API version. Plugins cannot replace bundled providers or register arbitrary commands. Plugins can add `connect <provider>` through the connection callbacks described below. Limrun, BrowserStack, and AWS Device Farm remain bundled.

For an Appium or WebDriver service, return `{ webDriver: options }` instead of building an engine. `WebDriverPluginOptions` is available through the type-only `agent-device/plugins/webdriver` import. Core supplies the client version and creates the shared runtime. Provider callbacks prepare sessions, upload apps, and retrieve artifacts.

To support `agent-device connect example`, declare `agentDevicePlugin.connection` in the package manifest:

```json
{
  "agentDevicePlugin": {
    "apiVersion": 1,
    "provider": "example",
    "entry": "./dist/plugin.mjs",
    "connection": {
      "leaseKind": "direct-device-provider",
      "requiresAppAttachment": false,
      "requiresRemoteDaemon": false,
      "supportsArtifacts": false,
      "supportsDeferredAppSelection": true,
      "supportsDirectPortReverse": false,
      "usesCloudWebDriverLease": false
    }
  }
}
```

If the provider reads credentials from the environment, list the variables in `agentDevicePlugin.credentialVariables`, for example `["EXAMPLE_USERNAME", "EXAMPLE_ACCESS_KEY"]`. A local daemon keeps the values it started with; when the shell holds different ones, the first command that allocates a lease refuses with reason `provider-credentials-changed` until the daemon is stopped. Core reads this list from the manifest without loading the plugin, and treats a whitespace-only value as unset.

Return `connection` alongside the runtime or WebDriver options. Its `resolve({ flags, env, cwd, stateDir })` callback validates provider flags and returns `{ profile, extraFlags? }`; `profile.leaseProvider` must match the manifest. Core supplies connection identity, session defaults, Metro settings, and persists the profile. Its async `verify({ flags, env })` callback returns the provider verification result. These callbacks run without allocating a device and their temporary runtimes are shut down afterwards.

Bundle the plugin implementation and ship ready-to-run ESM: installation disables lifecycle scripts. Bundle shared implementation helpers with the plugin; `AppError` carries a shared brand so core preserves its code and details across package copies. Import types with `import type` to keep them out of the runtime dependency graph.
