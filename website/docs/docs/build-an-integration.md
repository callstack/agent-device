---
title: Build an integration
---

Use the [Node.js API](/docs/client-api) to drive devices from your integration. The package also exports selector helpers and types for provider plugins.

## API reference

- `agent-device/contracts`
  - `defaultHintForCode`
- `agent-device/selectors`
  - `listSelectorChainMatches`, `parseSelectorChain`
- `agent-device/plugins`
  - types: `AgentDevicePlugin`, `MacOsPlatformLeafContribution`, `PlatformBackgroundProcess`, `PlatformContribution`, `PlatformHost`, `PlatformOutputSink`, `PlatformSetup`, `PluginConnection`, `PluginConnectionContext`, `PluginRuntimeSetup`, `ProviderAgentDevicePlugin`, `ProviderPluginHost`, `RunHostCommand`

## Parse a selector

```ts
import { parseSelectorChain } from 'agent-device/selectors';

const selector = parseSelectorChain('role=button label="Continue"');
console.log(selector);
```

## Migrate to 0.22

The API references on this page and the [Node.js API page](/docs/client-api#api-reference)
list the public imports for 0.22. The methods on `AgentDeviceClient` remain available.

| Previous import | What to use in 0.22 |
| --- | --- |
| `startAgentDevice` from `agent-device` | Start a detached daemon with `ensureDaemon({ stateDir })`, then create a client for that same state directory. See [Daemon lifecycle](/docs/client-api#daemon-lifecycle). |
| `addPluginArtifact` from `agent-device/plugins` | Run [`agent-device plugins add ./plugin.tgz`](/docs/plugins#install-a-local-plugin-artifact) on the host that needs the plugin. |
| `agent-device/ai-sdk` | Connect through the [MCP server](/docs/agent-setup#mcp-server) or build tools with the [Node.js API](/docs/client-api). |
| `agent-device/batch` | Send a batch to the daemon with [`client.batch.run({ steps })`](/docs/client-api#command-methods) or the [CLI](/docs/batching). For custom in-process dispatch, keep orchestration in your integration. |
| `agent-device/finders` | Query the active session with `client.interactions.find()`. For a detached snapshot, use `parseSelectorChain()` and `listSelectorChainMatches()` from `agent-device/selectors`. |
| `agent-device/metro` | Use `client.metro.prepare()` and `client.metro.reload()` for session Metro operations. |
| `agent-device/remote-config` | Configure the remote daemon URL and transport in your integration. See [Remote proxy](/docs/remote-proxy). |
| `agent-device/android-adb`, `agent-device/artifacts`, `agent-device/install-source`, `agent-device/io` | These low-level helpers have no direct public replacement. Keep custom ADB, APK inspection, URL validation, and file I/O in your integration. |

When a removed type describes a client method's options or result, derive it from
`AgentDeviceClient` with TypeScript's `Parameters` or `Awaited<ReturnType<…>>`.
For example, `Parameters<AgentDeviceClient['batch']['run']>[0]` gives the batch options.

### Names removed from retained entries

| Previous import | What to use in 0.22 |
| --- | --- |
| `normalizeError` from `agent-device/contracts` | Import `normalizeAgentDeviceError` from `agent-device`. |
| `centerOfRect` from `agent-device` or `agent-device/contracts` | Calculate the center locally. Round `x + width / 2` and `y + height / 2` if you need the previous integer coordinates. |
| `isUnreadableCaptureContentError` from `agent-device` | Inspect the normalized error details. Android capture reports `details.androidSnapshotHelperFailureReason` when it has a helper failure reason. |
| `createLocalArtifactAdapter` from `agent-device` | Keep file I/O in your integration, or use the client method for the artifact operation you need. |
| `findSelectorChainMatch` or `resolveSelectorChain` from `agent-device/selectors` | Use `listSelectorChainMatches()` for the first alternative with matches. Apply your own uniqueness rule if you need one match. |
| `tryParseSelectorChain`, `isSelectorToken`, or `formatSelectorFailure` from `agent-device/selectors` | Parse with `parseSelectorChain()`, catch parse errors, and format your integration's diagnostics. |
| `isNodeEditable` or `isNodeVisible` from `agent-device/selectors` | Apply your integration's own checks to the snapshot node. These helpers have no public replacement. |
| `AgentDeviceClientConfig` or `EnsureDaemonOptions` from `agent-device` | Derive the options with `NonNullable<Parameters<typeof createAgentDeviceClient>[0]>` or `NonNullable<Parameters<typeof ensureDaemon>[0]>`. |
| `AgentDeviceDevice` from `agent-device` | Derive the result item with `Awaited<ReturnType<AgentDeviceClient['devices']['list']>>[number]`. |
| `AppErrorCode` from `agent-device` | Derive the code type with `ConstructorParameters<typeof AppError>[0]`. |
| `DaemonBinding`, `AgentDeviceHost`, or `StartAgentDeviceOptions` from `agent-device` | Use the detached lifecycle above. The SDK no longer exposes embedded-host creation or its binding types. |
| `SelectorChain` from `agent-device/selectors` | Use `ReturnType<typeof parseSelectorChain>`. |
| Other removed types from `agent-device/contracts`, `agent-device/selectors`, or `agent-device/plugins` | Use types inferred from retained APIs where applicable. The [API reference](#api-reference) lists the supported plugin types. Internal wire and selector-diagnostic types have no direct replacement. |
