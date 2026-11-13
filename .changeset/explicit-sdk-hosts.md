---
'agent-device': minor
---

Require explicit SDK host dependencies in 0.22. Part of #3759 section 3.

Pass `{ env, cwd }` to `runAndroidShell(device, words, host, options?)`, `runAndroidExecOut(device, words, host, options?)`, `resolveAndroidArchivePackageName(archivePath, host, signal?)`, `prepareMetroRuntime(options, host)`, and `new LimrunRuntime(options, host)`. For example, capture `const host = { env: { ...process.env }, cwd: process.cwd() }` in your entry point, then call `await prepareMetroRuntime(options, host)`.

`resolveRemoteConfigProfile({ configPath, cwd, env })` requires `env`, and `createLocalArtifactAdapter({ cwd })` requires `cwd`. Archive inspection resolves relative paths from the supplied host and no longer shares a cached SDK tool across hosts. The internal contracts, host-kit, remote, and platform-android packages are bundled into `agent-device`; this changeset covers their affected public APIs.

Executable captures and `startAgentDevice`'s optional-host capture remain available. See [Build an integration](/docs/build-an-integration#migrate-sdk-hosts-to-022) for migration examples.
