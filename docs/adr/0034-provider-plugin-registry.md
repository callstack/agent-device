# 0034. Provider plugin registry

Status: accepted. Umbrella #3747; contract and registry #3755.

## Rules at a glance

- The 0.22 plugin contract changes once to version 3.
- One daemon-lifetime registry selects claims from bundled, store, and embedder candidates.
- A package may contribute multiple independently activated kinds.
- Static package claims are validated before import and matched against the factory result.
- Setup owns partial acquisitions; the registry owns successful registrations and cleanup.
- Optional families may be absent; required families retain completeness checks.

## Context

Three things loaded providers: a hand-kept `RESERVED_PLUGIN_PROVIDERS` list, a second list of providers the daemon must have a runtime for, and a store that treated one bad plugin as a daemon startup failure.
Each provider kind also needed its own path for credential fingerprints and for `connect` capabilities, which read manifests the bundled providers do not have.
An embedding host had to fake the store to load a plugin from its own dependencies (#3747).

In 0.22, providers, replay, and platform families need one plugin contract.

## Decision

The options-taking factory remains at the `./agent-device` entry.
The managed store remains the installation owner.
The store calls the factory with `config.json` `plugins[name].options`.
A JavaScript host passes its own options.
A plugin that takes credentials as options declares no environment variables for them.
Those credentials stay out of the environment fingerprint.
The host resolves the entry with import conditions and falls back to the package root only when the subpath is absent.
For a package without `exports`, the root export is `main`.
An import or setup failure never triggers fallback.
The factory contract has no runtime helper.
The factory contract does not depend on the plugin's module URL.
Plugins import contract types from `agent-device/plugins`.
The host-side `addPluginArtifact(path, { env, cwd })` operation shares the managed store.
The factory returns `{ apiVersion: 3, contributes: [Contribution, ...Contribution[]] }`.
The factory acquires no resources.
The current version 3 contracts are in `packages/plugins/src/contract.ts` and `packages/plugins/src/replay-backend.ts`.
The current registry is in `packages/plugins/src/registry.ts`.

Each contribution has one kind and a narrow host type for that kind.
A `provider` declares its provider id, credentials, optional connection, and setup with a provider host.
Provider setup returns `{ runtime, platformModule, dispose? }` or `{ webDriver, dispose? }`.
A `{ webDriver }` result remains a data descriptor that the host interprets.
The optional `dispose` belongs to that registration.
A `platform` declares a platform family and setup with a platform host.
Platform setup returns inventory and runtime modules, request-provider scoping, and named operations.
Platform setup, doctor, and orphan recovery are explicit operations.
There is no general lifecycle callback.
A `replay-backend` declares a format backend id, such as Maestro.
A `replay-execution` declares the id `ad` for native replay and test.
There is no open-ended `feature` kind.
A new kind requires an explicit decision, a named owner, a typed operation, and a consuming command.

The `agent-device` field in package metadata contains only `apiVersion` and static claims.
Package `name` and `version` establish identity.
The declared engines range establishes the Node floor.
Before import, the host verifies selection identity, entry containment, supported API, Node floor, and unique claims.
After the factory runs with its options, declared and returned claims must be exactly equal without regard to order.
At setup, returned runtime owners and family modules must match their keys.
Credentials, callbacks, and runtime facts remain in code.
This explicitly replaces the former decision that package metadata declares no claims.
Options-dependent credentials cannot be represented reliably in static metadata.

The host validates the whole declaration before publishing any claim.
It reserves claims in deterministic candidate order.
The first registration keeps its claim even when that registration fails.
Later registrations of that claim are recorded as failed.
`cloud` and `proxy` remain reserved.
A manifest and factory mismatch invalidates the package.
A cross-package duplicate fails the losing claim.
The host activates only claims needed by its scope.
Each claim has an independent setup outcome, so a broken provider does not disable a replay claim from the same package.
Setup owns partial acquisitions until it returns.
The registry then owns cleanup.
`registry.close()` is the single idempotent cleanup owner.
It returns an outcome per registration and step.
It never wraps runtimes.
When a later composition step fails, composition closes the registry before it throws.
The registry starts closing activated registrations in reverse order.
Those teardowns run concurrently, so one hanging disposer cannot stall the others.
It shuts each runtime down before its disposer.
Close is memoized.
There is no package-level `dispose`.

A core catalog maps known optional families to install hints.
Engine-free vetted declarations supply help and missing-plugin install commands.
They do not establish whether an engine is installed or working.
Unknown names produce no inferred package.
The authoritative package names use the maintainer-controlled `@agent-device/*` npm scope.
Typed outcomes distinguish absent `plugin-not-installed`, invalid, incompatible API, below-floor Node, duplicate claim, load or setup failure, and stale selection.
Replay setup remains engine-free until the backend is selected.
The runtime registry memoizes engine creation and owns disposal after requests drain.
Client-side source collection and export close their scoped registry.
A missing replay execution returns `plugin-not-installed` before device binding.
A package added after daemon startup returns `daemon-plugin-set-stale`.
The caller finishes sessions and restarts the host.
A changed plugin set takes effect in the next daemon.
The inventory lists every claim as `active` or `failed`, with a typed `error.reason`.
It is published in `daemon.json` and by `agent-device daemon status`.
Failure is data.
Behavior keys on `error.reason`, never on the message.
A selected package retains its load, validation, compatibility, or setup reason.
The daemon inventory records failures without stopping other claims.
A client reads daemon inventory from `daemon.json`.
The inventory supplies credential variable names for the client fingerprint.
A client loads store declarations without runtime setup to read connection capabilities.
The daemon record has one reader and distinguishes absent, unreadable, and invalid states.
A missing or stale record reads as stopped; an unreadable or invalid record does not.
An embedded registry does not consult the store for recovery.

The registry receives candidates.
Composition chooses their sources.
One resolver selects required bundled mobile modules, transitional built-in providers, and store or embedder candidates.
Inventory, runtime, request providers, and cleanup read that selection.
Required families retain completeness checks.
Optional families may be absent.
The current composition is in `src/platform-runtime.ts` and the family contract is in `packages/contracts/src/platform-module.ts`.
macOS desktop remains a leaf under the single `apple` identity.
How the desktop runtime plugs into that identity is decided in [#4675](https://github.com/callstack/agent-device/issues/4675).
ADR 0019 defines the platform runtime boundary.

Version 2 plugins receive a typed incompatibility outcome without a compatibility shim.
The external provider plugin [@nomac/agent-device](https://github.com/NoMac-app/agent-device-plugin) version 0.1.0 uses version 2 and needs a coordinated version 3 release.

The accepted order is this ADR, then [#4723](https://github.com/callstack/agent-device/pull/4723) for the Limrun factory on version 2.
One subsequent PR moves the registry and all maintained plugins to version 3: BrowserStack, AWS Device Farm, TestMu, Revyl, Tizen, webOS, Limrun, Maestro, and native replay.
The Limrun Android interactor cutover stays in the Limrun extraction PR under the [#3311 decision](https://github.com/callstack/agent-device/issues/3311#issuecomment-7003449585).
Web [#4597](https://github.com/callstack/agent-device/issues/4597) is the first production `platform` contribution, followed by HarmonyOS #4317, Vega #4672, Linux #4676, and macOS #4675.

## Rationale and alternatives

Static claims permit validation before code import and deterministic ownership.
The factory keeps options-dependent credentials in code.
A manifest-only contract was rejected because it cannot express those credentials.
A shared host was rejected because each kind needs a narrow authority.
A runtime helper was rejected because plugins would depend on a runtime export.
Failing the daemon for one optional plugin was rejected because unrelated claims can still work.

Decision history (2026-11-17): the public artifact manager API in [#4615](https://github.com/callstack/agent-device/pull/4615) narrows the entry's type-only restriction to plugin factories.
Hosts can use the shared manager without adding a runtime helper dependency to plugins.

Decision history (2026-11-19): version 3 replaces the version 2 manifest-free contract to support independently scoped platform and replay contributions.

## Daemon ownership

Clients attach to an existing daemon and cannot start or replace one. Call `ensureDaemon()` to start or replace a detached daemon explicitly. An embedder calls `startAgentDevice({ stateDir, plugins?, host? })` from `agent-device` to own a runtime in its process. The main entry loads the runtime when called. The returned client and serializable `clientConfig` identify that exact instance. Attaching checks normal version and code compatibility before checking the instance pin. `close()` in the host process is the only way to shut an embedded runtime down, and returns its `ShutdownReport`. `daemon stop` refuses live embedded ownership with `daemon-owner-embedded` and live unrecognized ownership with `daemon-owner-unrecognized`, without a request or signal. The embedded-ownership refusal names the host PID and directs the caller to close the runtime there. Stop may retire an embedded or unrecognized registration when its recorded host lifetime has provably exited. The CLI cannot replace a live embedded runtime. Registration and its lock remain held while requests or platform owners are unfinished.

The embedder supplies plugin objects directly. They follow the built-ins through the same registry validation; this runtime does not read the plugin store. Plugin failures remain inventory data. Logging adapters, a separate package entry, and disposal protocols are not required to own a daemon: the library exposes the client, its attach configuration, and `close()`.

Decision history: owner-only close replaces external embedded shutdown so the CLI cannot end work its host owns; a proven host exit permits registration retirement. The former client-managed startup path was removed in 0.22; explicit ensuring keeps daemon replacement separate from attachment (#3759). The main-entry API replaces the proposed host subpath and optional host controls, keeping ownership and attachment on the existing runtime and client paths (#3757).

## Alternatives refused

- **Outside shutdown of an embedded runtime.** The host that starts it owns its close. Letting another process close the runtime would cross that ownership boundary and duplicate the host's close handle.

- **Keep the manifest as the contract.** It cannot describe options-dependent credentials, and a
  bundled provider has no package to hold one.
- **A runtime helper such as `definePlugin`.** It would make plugins depend on a runtime export of
  agent-device and its version, which is what a type-only contract avoids.
- **Fail the daemon on a bad plugin.** One broken optional package then takes every provider down.
