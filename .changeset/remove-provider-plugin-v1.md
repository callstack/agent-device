---
'agent-device': minor
'@agent-device/testmu': minor
'@agent-device/revyl': minor
---

Remove the version 1 provider plugin contract. A store package is now discovered only through its exports: `./agent-device`, or the package root when that subpath is absent. The host no longer reads an `agentDevicePlugin` manifest to choose an entry or to declare a provider, connection capabilities, or credential variables, and `agent-device plugins add` no longer refuses a package for a provider another manifest claims — the registry settles a duplicate provider id when the daemon next composes its plugins, as the first claim wins.

Migrate a plugin by exporting its factory from `./agent-device` and returning the manifest's values from the factory: `provider`, `credentials: { variables: [...] }`, an optional `connection`, and `setup(host)` that returns `{ runtime, platformModule }` or `{ webDriver }`, with `apiVersion: 2`. See [Provider plugins](/docs/plugins) for the full migration. A package whose default export is not a version 2 plugin is listed as `failed` with `incompatible_plugin` and the daemon starts without it.
