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
