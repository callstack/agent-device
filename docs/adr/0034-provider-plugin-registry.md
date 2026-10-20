# 0034. Provider plugin registry

Status: accepted. Umbrella #3747; contract and registry #3755.

## Rules at a glance

- One contract. A provider plugin is a factory that returns `{ apiVersion: 2, provider, credentials,
  connection?, setup(host) }`. `setup` returns `{ runtime, platformModule, dispose? }` or
  `{ webDriver, dispose? }`. A `{ webDriver }` result stays a data descriptor the host interprets.
- One registry. Composition selects built-in, store, or embedder sources. Built-in providers use the
  same shape as an installed plugin, and one function validates what every factory returns.
- Plugins import only types from agent-device. The type-only contract is `agent-device/plugins`;
  there is no runtime helper, and the contract does not depend on a plugin's module URL.
- The first registration of a provider id claims it, even when that registration fails. Later ones
  are recorded as failed. `cloud` and `proxy` are routing identities no plugin can claim.
- A plugin that fails to enumerate, load, validate or set up is recorded and skipped. The daemon
  starts with the rest. The inventory lists every plugin as `active` or `failed`, with a typed
  `error.reason`, and is published in `daemon.json` and by `agent-device daemon status`.
- `registry.close()` is the single, idempotent cleanup owner. It shuts down each runtime, then calls
  its `dispose`, and returns an outcome per plugin and step. Runtimes are never wrapped.
  Composition is transactional: when a later step fails, it closes the registry before it throws.
- The registry receives candidates. Composition chooses the sources.
- `daemon.json` has one reader. Its states are `absent`, `unreadable`, and `invalid`. A missing or
  stale record reads as a stopped daemon; an unreadable or invalid one never does.
- The plugin set is fixed for a daemon's lifetime. A plugin change takes effect on the next daemon.
- v1 plugins (`agentDevicePlugin.apiVersion: 1`) without a `./agent-device` export are dispatched by
  their manifest before any code runs and load through an adapter until 0.22 removes them (#3759).
  A package that keeps the manifest and also exports `./agent-device` loads as v2; hosts without
  v2 still read the manifest.

## Context

Three things loaded providers: a hand-kept `RESERVED_PLUGIN_PROVIDERS` list, a second list of
providers the daemon must have a runtime for, and a store that treated one bad plugin as a daemon
startup failure. Each provider kind also needed its own path for credential fingerprints and for
`connect` capabilities, which read manifests the bundled providers do not have. An embedding host
had to fake the store to load a plugin from its own dependencies (#3747).

## Decisions

- **A factory takes options.** The store calls it with `config.json` `plugins[name].options`; a JS
  host calls it directly with its own, such as credentials. A plugin that takes credentials as
  options declares no environment variables for them, so they stay out of the environment
  fingerprint.
- **A package exports its entry as `./agent-device`.** The host resolves it with import
  conditions and falls back to the package root only when the subpath is absent. A subpath whose
  import or setup throws never falls back. A v2 package needs no manifest.
- **The registry owns identity, not the retired lists.** Duplicate ids and bundled ids are one
  question answered by claim order. Credential variables, per-backend narrowing and connect
  capabilities are read from the registry's plugins, not from manifests. A v1 manifest still
  supplies them for a v1 plugin.
- **Failure is data.** A failed plugin is an inventory entry, not an exception. Behavior keys on
  `error.reason`, never on the message.
- **A client reads a daemon's inventory from `daemon.json`.** The client credential fingerprint
  takes variable names from it and falls back to v1 manifests. A v2 plugin declares its connect
  capabilities in code, so a client loads the store, without setting up a runtime, before it reads
  them.

## Daemon ownership

Clients retain managed and attach lifecycles. Managed clients may start a daemon; attach clients cannot start or replace one. An embedder calls `startAgentDevice({ stateDir, plugins?, host? })` from `agent-device` to own a runtime in its process. The main entry loads the runtime when called. The returned client and serializable `clientConfig` identify that exact instance. Attaching checks normal version and code compatibility before checking the instance pin. `close()` shuts the runtime down. The CLI cannot signal or replace an embedder-owned runtime.

The embedder supplies plugin objects directly. They follow the built-ins through the same registry validation; this runtime does not read the plugin store. Plugin failures remain inventory data. Logging adapters, a separate package entry, and disposal protocols are not required to own a daemon: the library exposes the client, its attach configuration, and `close()`.

Decision history: the former explicit-start target is dropped; the client lifecycle continues to choose startup behavior. The main-entry API replaces the proposed host subpath and optional host controls, keeping ownership and attachment on the existing runtime and client paths (#3757).

## Alternatives refused

- **Keep the manifest as the contract.** It cannot describe options-dependent credentials, and a
  bundled provider has no package to hold one.
- **A runtime helper such as `definePlugin`.** It would make plugins depend on a runtime export of
  agent-device and its version, which is what a type-only contract avoids.
- **Fail the daemon on a bad plugin.** One broken optional package then takes every provider down.
