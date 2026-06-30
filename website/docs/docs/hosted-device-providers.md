---
title: Hosted Device Providers
description: Configure BrowserStack and AWS Device Farm so agents can connect without interactive login.
---

# Hosted Device Providers

Use hosted provider connections when the agent should drive BrowserStack App Automate or AWS Device Farm remote access through the local `agent-device` daemon:

```bash
agent-device connect browserstack ...
agent-device connect aws-device-farm ...
```

These providers are not remote `agent-device` daemons. `connect browserstack` and `connect aws-device-farm` write a local generated profile, then the first lease-allocating command such as `open` creates the hosted WebDriver session.

## Autonomous Agent Requirements

Agents can connect autonomously when all required credentials and selectors are present before the command starts.

- Do not rely on browser-based login inside the agent workflow.
- Put provider credentials in CI secrets, a local ignored env file, or the CI platform's secret store.
- Keep generated remote profiles non-secret. They may contain provider app ids, Device Farm ARNs, device names, OS versions, and labels; they must not contain BrowserStack access keys or AWS secret keys.
- Run `agent-device artifacts --json` after `close` when the provider has video/log URLs to fetch.

## BrowserStack

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

## AWS Device Farm

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

## Minimal CI Shape

```bash
# BrowserStack
BROWSERSTACK_USERNAME=...
BROWSERSTACK_ACCESS_KEY=...
agent-device connect browserstack --platform android --device "Google Pixel 8" --provider-os-version 14.0 --provider-app bs://app-id
agent-device open com.example.app
agent-device snapshot -i
agent-device close
agent-device artifacts --json
agent-device disconnect
```

```bash
# AWS Device Farm
AWS_REGION=us-west-2
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_SESSION_TOKEN=...
agent-device connect aws-device-farm --platform android --aws-project-arn "$AWS_DEVICE_FARM_PROJECT_ARN" --aws-device-arn "$AWS_DEVICE_FARM_DEVICE_ARN" --aws-app-arn "$AWS_DEVICE_FARM_APP_ARN"
agent-device open com.example.app
agent-device snapshot -i
agent-device close
agent-device artifacts --json
agent-device disconnect
```

## Troubleshooting

- If BrowserStack connect fails before opening a session, check `BROWSERSTACK_USERNAME`, `BROWSERSTACK_ACCESS_KEY`, `--provider-app`, `--provider-os-version`, and `--device`.
- If AWS allocation fails, first run `aws sts get-caller-identity` in the same CI step to confirm the AWS CLI credential chain is active, then verify the Device Farm ARNs and region.
- If artifact lookup is pending immediately after `close`, retry `agent-device artifacts --json`. Some providers finalize video/log URLs asynchronously after the hosted session stops.
