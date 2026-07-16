---
title: Device Clouds & Farms
description: Connect agents to Limrun, BrowserStack, and AWS Device Farm without interactive login.
---

# Device Clouds & Farms

Use device cloud and device farm connections when the agent should drive Limrun direct instances, BrowserStack App Automate, or AWS Device Farm remote access through the local `agent-device` daemon:

```bash
agent-device connect browserstack ...
agent-device connect aws-device-farm ...
agent-device connect limrun ...
```

These providers are not remote `agent-device` daemons. `connect` writes a local generated profile, then the first lease-allocating command such as `open` creates the provider session. BrowserStack and AWS Device Farm use hosted WebDriver sessions; Limrun uses its direct iOS/Android provider runtime.

## Interface Summary

Device cloud providers have one setup model and three ways to drive the resulting session:

| Interface         | What it does well                                                                                              | How provider setup works                                                                                                                                                                  |
| ----------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI               | Best default for agents and CI. It creates the local provider profile once, then normal commands inherit it.   | Run `agent-device connect limrun`, `agent-device connect browserstack`, or `agent-device connect aws-device-farm`, then normal device commands.                              |
| JavaScript client | Best for Node integrations that already own process configuration.                                             | Pass provider fields in `createAgentDeviceClient(...)` config or per-command options, then call normal client methods such as `client.apps.open(...)` and `client.capture.snapshot(...)`. |
| MCP               | Best for tool-only agents after bootstrap. MCP exposes operational tools backed by the same command contracts. | Run CLI `connect ...` before starting or using the MCP server in the same effective state directory. MCP intentionally does not expose `connect` or `disconnect` as provider setup tools. |

The CLI is the canonical bootstrap path because it persists a non-secret generated profile and keeps provider credentials in the environment. After bootstrap, CLI, JavaScript, and MCP all use the same daemon/session behavior.

## Autonomous Agent Requirements

Agents can connect autonomously when all required credentials and selectors are present before the command starts.

- Do not rely on browser-based login inside the agent workflow.
- Put provider credentials in CI secrets, a local ignored env file, or the CI platform's secret store.
- Keep generated remote profiles non-secret. They may contain provider app ids, Device Farm ARNs, device names, OS versions, and labels; they must not contain Limrun API keys, BrowserStack access keys, or AWS secret keys.
- Run `agent-device artifacts --json` after `close` when the provider has video/log URLs to fetch.

## CLI Experience

The CLI experience is:

1. Export provider credentials.
2. Run `agent-device connect <provider>` with provider selectors.
3. Run normal `agent-device` commands.
4. Run `agent-device close` to stop the hosted session.
5. Run `agent-device artifacts --json` to retrieve provider-hosted video/log/dashboard URLs.
6. Run `agent-device disconnect` to clear local connection state.

### Limrun

Required environment:

```bash
export LIMRUN_API_KEY=...
```

`LIMRUN_REGION` optionally selects a Limrun region.

Choose the platform to create a matching instance:

```bash
agent-device connect limrun --platform android
```

Limrun creates remote iOS simulators and Android emulators only. It does not use local or physical-device selectors such as `--udid`, `--serial`, or `--device`.

Full Android flow:

```bash
export LIMRUN_API_KEY=...

agent-device connect limrun --platform android
agent-device open com.example.app
agent-device snapshot -i
agent-device click 'label="Continue"'
agent-device close
agent-device disconnect
```

Limrun Android uses the direct ADB tunnel, so the normal Android helper-backed snapshots, installs, and port reverse flow are available. This makes a local Metro server reachable through the normal Android reverse setup.

Limrun iOS uses the direct Limrun iOS client. It supports normal app lifecycle, snapshots, screenshots, taps, text input, scrolling, and app install, but it cannot reverse a remote device port to a local host port. For iOS Metro or React DevTools, use a publicly reachable HTTPS endpoint or a bridge URL rather than a local-only address. Limrun does not currently expose provider artifacts through `agent-device artifacts`.

### BrowserStack

Required environment:

```bash
export BROWSERSTACK_USERNAME=...
export BROWSERSTACK_ACCESS_KEY=...
```

Required connection selectors:

```bash
agent-device connect browserstack \
  --platform android \
  --device "Google Pixel 8" \
  --provider-os-version 14.0 \
  --provider-app bs://app-id
```

`--provider-app` accepts a BrowserStack app reference such as `bs://...`, an HTTP(S) app URL, or an existing local app path. Local paths are uploaded to BrowserStack when the hosted session is allocated.

Optional labels:

```bash
--provider-project agent-device
--provider-build "$GITHUB_RUN_ID"
--provider-session-name "$GITHUB_JOB"
```

Full flow:

```bash
export BROWSERSTACK_USERNAME=...
export BROWSERSTACK_ACCESS_KEY=...

agent-device connect browserstack \
  --platform android \
  --device "Google Pixel 8" \
  --provider-os-version 14.0 \
  --provider-app bs://app-id \
  --provider-project agent-device \
  --provider-build "$GITHUB_RUN_ID"

agent-device open com.example.app
agent-device snapshot -i
agent-device click 'label="Continue"'
agent-device close
agent-device artifacts --json
agent-device disconnect
```

### AWS Device Farm

AWS Device Farm uses the AWS CLI credential provider chain. `agent-device` does not require `aws login`; it shells out to `aws devicefarm ...`, so any non-interactive AWS CLI credential source that works in CI works here. The AWS CLI documents environment variables such as `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_REGION`, `AWS_PROFILE`, `AWS_ROLE_ARN`, and `AWS_WEB_IDENTITY_TOKEN_FILE` in the [AWS CLI environment variable reference](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-envvars.html).

Prefer short-lived CI credentials over long-lived IAM user keys. In GitHub Actions, use OIDC to assume an IAM role and let the action export the standard AWS environment variables; AWS documents IAM OIDC providers in the [IAM OIDC provider guide](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_providers_create_oidc.html), and the official `aws-actions/configure-aws-credentials` action documents the GitHub Actions setup in its [configure-aws-credentials repository](https://github.com/aws-actions/configure-aws-credentials). For other CI systems, use the platform's AWS federation support when available. If static keys are unavoidable, store them as CI secrets and scope their IAM policy to the needed Device Farm project/actions.

Typical CI environment after federation or secret injection:

```bash
export AWS_REGION=us-west-2
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
export AWS_SESSION_TOKEN=... # present for temporary credentials
```

AWS web identity flows can also use the AWS CLI's environment variables:

```bash
export AWS_ROLE_ARN=arn:aws:iam::<account-id>:role/<role-name>
export AWS_WEB_IDENTITY_TOKEN_FILE=/path/to/token
export AWS_REGION=us-west-2
```

Required connection selectors:

```bash
agent-device connect aws-device-farm \
  --platform android \
  --aws-project-arn arn:aws:devicefarm:us-west-2:<account-id>:project:<project-id> \
  --aws-device-arn arn:aws:devicefarm:us-west-2::device:<device-id> \
  --aws-app-arn arn:aws:devicefarm:us-west-2:<account-id>:upload:<upload-id>
```

`--aws-app-arn` is optional when the remote access session does not need an uploaded app attached. You can also provide ARNs through environment variables:

```bash
export AWS_DEVICE_FARM_PROJECT_ARN=...
export AWS_DEVICE_FARM_DEVICE_ARN=...
export AWS_DEVICE_FARM_APP_ARN=...
```

`AGENT_DEVICE_AWS_DEVICE_FARM_PROJECT_ARN`, `AGENT_DEVICE_AWS_DEVICE_FARM_DEVICE_ARN`, and `AGENT_DEVICE_AWS_DEVICE_FARM_APP_ARN` are accepted as agent-device-specific aliases.

Full flow:

```bash
export AWS_REGION=us-west-2
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
export AWS_SESSION_TOKEN=...

agent-device connect aws-device-farm \
  --platform android \
  --aws-project-arn "$AWS_DEVICE_FARM_PROJECT_ARN" \
  --aws-device-arn "$AWS_DEVICE_FARM_DEVICE_ARN" \
  --aws-app-arn "$AWS_DEVICE_FARM_APP_ARN" \
  --provider-session-name "$GITHUB_JOB"

agent-device open com.example.app
agent-device snapshot -i
agent-device close
agent-device artifacts --json
agent-device disconnect
```

## JavaScript Client Experience

Use the JavaScript client when a Node process owns the provider configuration and does not need a persisted CLI connection profile. Provider selectors can live in the client config and normal methods drive the session.

```bash
export BROWSERSTACK_USERNAME=...
export BROWSERSTACK_ACCESS_KEY=...
```

```ts
import { createAgentDeviceClient } from 'agent-device';

const client = createAgentDeviceClient({
  leaseProvider: 'browserstack',
  platform: 'android',
  device: 'Google Pixel 8',
  providerOsVersion: '14.0',
  providerApp: 'bs://app-id',
  providerProject: 'agent-device',
  providerBuild: process.env.GITHUB_RUN_ID,
});

await client.apps.open({ app: 'com.example.app' });
const snapshot = await client.capture.snapshot({ interactiveOnly: true });
console.log(snapshot.nodes.slice(0, 5));
await client.interactions.click({ selector: 'label="Continue"' });
const closed = await client.sessions.close();
const providerSessionId = closed.provider?.providerSessionId;

if (providerSessionId) {
  const artifacts = await client.sessions.artifacts({
    provider: 'browserstack',
    providerSessionId,
  });
  console.log(artifacts.cloudArtifacts);
}
```

AWS Device Farm uses the same shape with AWS fields:

```ts
const client = createAgentDeviceClient({
  leaseProvider: 'aws-device-farm',
  platform: 'android',
  awsProjectArn: process.env.AWS_DEVICE_FARM_PROJECT_ARN,
  awsDeviceArn: process.env.AWS_DEVICE_FARM_DEVICE_ARN,
  awsAppArn: process.env.AWS_DEVICE_FARM_APP_ARN,
  awsRegion: process.env.AWS_REGION,
});
```

The JavaScript client does not publish provider SDK subpaths. Use the normal typed client methods; provider implementation details stay internal. Limrun uses the same client shape with `leaseProvider: 'limrun'`, `platform: 'android'` or `platform: 'ios'`, and `LIMRUN_API_KEY` in the daemon environment.

## MCP Experience

The MCP server exposes operational command tools such as `open`, `snapshot`, `click`, `close`, and `artifacts`. It does not expose provider `connect` commands.

For MCP-only operation, bootstrap with the CLI first in the same effective state directory:

```bash
export BROWSERSTACK_USERNAME=...
export BROWSERSTACK_ACCESS_KEY=...
agent-device connect browserstack --platform android --device "Google Pixel 8" --provider-os-version 14.0 --provider-app bs://app-id
agent-device mcp
```

Then an MCP client can call the normal tools:

```text
open { "app": "com.example.app" }
snapshot { "interactiveOnly": true }
click { "target": { "kind": "selector", "selector": "label=\"Continue\"" } }
close {}
artifacts {}
```

Use the same pattern for Limrun or AWS Device Farm: provide the provider credentials in the MCP server environment, run the corresponding CLI `connect` command once, then let MCP tools operate on the active connection. If an integration cannot run CLI bootstrap, use the JavaScript client path instead of MCP for provider setup.

## Artifact Lookup

`close` stops the active hosted session and may return a provider session id. `artifacts` fetches provider-hosted output:

```bash
agent-device artifacts --json
agent-device artifacts <provider-session-id> --provider browserstack --json
agent-device artifacts <session-arn> --provider aws-device-farm --json
```

BrowserStack can return session video, Appium logs, device logs, dashboard URL, and public URL. AWS Device Farm can return remote-access video and log artifacts after the provider finalizes them.

## Troubleshooting

- If BrowserStack connect fails before opening a session, check `BROWSERSTACK_USERNAME`, `BROWSERSTACK_ACCESS_KEY`, `--provider-app`, `--provider-os-version`, and `--device`.
- If AWS allocation fails, first run `aws sts get-caller-identity` in the same CI step to confirm the AWS CLI credential chain is active, then verify the Device Farm ARNs and region.
- If Limrun allocation fails, check `LIMRUN_API_KEY`, `--platform ios|android`, and the optional `LIMRUN_REGION`. Keep the key available in the environment used to start the local daemon.
- If artifact lookup is pending immediately after `close`, retry `agent-device artifacts --json`. Some providers finalize video/log URLs asynchronously after the hosted session stops.
