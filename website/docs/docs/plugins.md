# Provider plugins

Install optional providers with npm available on your host:

```bash
agent-device plugins add @example/agent-device-provider
agent-device plugins list --json
agent-device plugins update @example/agent-device-provider
agent-device plugins remove @example/agent-device-provider
```

Use a full npm package name, optionally with `@version` or `@tag`. `update` preserves valid constraints and options, including when repairing a damaged selection. Run `add <package>@<version-or-tag>` to change it, or `add <package>` without a suffix to remove it.

Each installation has an npm project and lockfile under `AGENT_DEVICE_HOME` (default `~/.agent-device`), selected in its `config.json`. Other settings are preserved. Project config and `--config` cannot select plugins. This home is independent of `--state-dir` and `AGENT_DEVICE_STATE_DIR`.

Installs disable lifecycle scripts: packages must contain ready-to-run JavaScript and assets. Use trusted packages; factories receive the daemon's host permissions and environment.

Failed installs keep the previous selection. Existing daemons retain their plugin set and files, including removed installations. Close sessions and run `agent-device daemon stop` with the appropriate `--state-dir`; the next device command uses the new set. Use separate state directories for different plugin homes.

Compatibility checks run offline using local metadata; provider operations may require network access. An incompatible plugin refuses daemon startup. Run `plugins list --json` to inspect errors, then update or remove the affected package. Core upgrades do not download replacements automatically.

## Creating a plugin

The interface is experimental. Publish this declaration in your package manifest:

```json
{"agentDevicePlugin": {"apiVersion": 1, "provider": "example", "entry": "./dist/plugin.mjs"}}
```

Use `agent-device` as a development dependency. The default factory accepts `ProviderPluginHost` from `agent-device/plugins`: `env`, package-specific `options`, `clientVersion`, Apple app packaging and resolution helpers under `apple`, and `createError` for host-recognized errors. Return `{ runtime, platformModule }` implementing the [provider runtime](https://github.com/callstack/agent-device/blob/main/packages/contracts/src/provider-device-runtime.ts) and [platform module](https://github.com/callstack/agent-device/blob/main/packages/contracts/src/platform-runtime-operations.ts) contracts. Both provider IDs must match the manifest; the module owner must declare `kind: 'provider-runtime'` and a nonempty `instance`. Core checks required runtime methods and owner metadata at startup; operation contracts are checked when used. Provider packages own implementation types; the SDK exposes only factory context. Set options through `plugins["<package>"].options` in user config; leave `installation` unchanged.

Keep initialization prompt and free of network I/O or device allocation; a stalled factory blocks startup. Load platform mechanics through `platformModule.loadRuntime` and perform remote work in request-bound operations. A failing factory cleans up its own resources; core shuts down previously returned runtimes if another plugin fails.

Incompatible contract changes require a new API version. Plugins cannot replace bundled providers or register arbitrary commands. Plugins can add `connect <provider>` through the connection callbacks described below. Limrun, BrowserStack, and AWS Device Farm remain bundled.

For an Appium or WebDriver service, return `{ webDriver: options }` instead of building an engine. `WebDriverPluginOptions` is available through the type-only `agent-device/plugins/webdriver` import. Core supplies the client version and creates the shared runtime. Provider callbacks prepare sessions, upload apps, and retrieve artifacts.

To support `agent-device connect example`, declare `agentDevicePlugin.connection` in the package manifest:

```json
{
  "leaseKind": "direct-device-provider",
  "requiresAppAttachment": false,
  "requiresRemoteDaemon": false,
  "supportsArtifacts": false,
  "supportsDeferredAppSelection": true,
  "supportsDirectPortReverse": false,
  "usesCloudWebDriverLease": false
}
```

Return `connection` alongside the runtime or WebDriver options. Its `resolve({ flags, env, cwd, stateDir })` callback validates provider flags and returns `{ profile, extraFlags? }`; `profile.leaseProvider` must match the manifest. Core supplies connection identity, session defaults, Metro settings, and persists the profile. Its async `verify({ flags, env })` callback returns the provider verification result. These callbacks run without allocating a device and their temporary runtimes are shut down afterwards.

Bundle the plugin implementation and ship ready-to-run ESM: installation disables lifecycle scripts. Bundle shared implementation helpers with the plugin; `AppError` carries a shared brand so core preserves its code and details across package copies. Import types with `import type` to keep them out of the runtime dependency graph.
