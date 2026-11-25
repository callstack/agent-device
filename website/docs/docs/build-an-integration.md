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

The `ai-sdk`, `android-adb`, `artifacts`, `batch`, `finders`, `install-source`, `io`, `metro`, and `remote-config` SDK subpaths were removed. Their helpers and other unlisted named exports are no longer public. Client methods remain available. For managed startup, call `ensureDaemon({ stateDir })` before creating the client. See [Daemon lifecycle](/docs/client-api#daemon-lifecycle).
