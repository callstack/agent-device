---
title: AWS Device Farm
description: Drive AWS Device Farm remote-access sessions with agent-device.
---

# AWS Device Farm

Use AWS Device Farm when an agent or CI job needs a hosted Android or iOS remote-access WebDriver session. The adapter does not route Vega OS or accept a Vega Fire TV ARN; the initial Vega workflow uses a local VVD only.

## Credentials and connection

AWS Device Farm uses the AWS CLI credential provider chain. `agent-device` does not require `aws login`; it runs `aws devicefarm ...`, so any non-interactive AWS CLI credential source that works in CI works here. See the [AWS CLI environment variable reference](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-envvars.html) for supported credential sources.

Prefer short-lived CI credentials over long-lived IAM user keys. In GitHub Actions, use OIDC to assume an IAM role and let the action export standard AWS environment variables. AWS documents [IAM OIDC providers](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_providers_create_oidc.html), and the official [`configure-aws-credentials` action](https://github.com/aws-actions/configure-aws-credentials) documents the GitHub Actions setup.

Typical CI environment:

```bash
export AWS_REGION=us-west-2
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
export AWS_SESSION_TOKEN=... # present for temporary credentials
```

AWS web identity flows can instead use:

```bash
export AWS_ROLE_ARN=arn:aws:iam::<account-id>:role/<role-name>
export AWS_WEB_IDENTITY_TOKEN_FILE=/path/to/token
export AWS_REGION=us-west-2
```

Connect with the Device Farm project, device, and optional app upload:

```bash
agent-device connect aws-device-farm \
  --platform android \
  --aws-project-arn arn:aws:devicefarm:us-west-2:<account-id>:project:<project-id> \
  --aws-device-arn arn:aws:devicefarm:us-west-2::device:<device-id> \
  --aws-app-arn arn:aws:devicefarm:us-west-2:<account-id>:upload:<upload-id>
```

`--aws-app-arn` is optional when the remote-access session does not need an uploaded app attached. You can also provide ARNs through environment variables:

```bash
export AWS_DEVICE_FARM_PROJECT_ARN=...
export AWS_DEVICE_FARM_DEVICE_ARN=...
export AWS_DEVICE_FARM_APP_ARN=...
```

`AGENT_DEVICE_AWS_DEVICE_FARM_PROJECT_ARN`, `AGENT_DEVICE_AWS_DEVICE_FARM_DEVICE_ARN`, and `AGENT_DEVICE_AWS_DEVICE_FARM_APP_ARN` are accepted as agent-device-specific aliases.

`connect` runs read-only `get-project`, `get-device`, and, when supplied, `get-upload` calls. It rejects a device or app for the wrong platform and an app upload that is not ready. AWS Device Farm does not support installing an app after remote-access session allocation; when an app is required, use the printed reconnect command, including `--session <name> --force`, before `open`.

## CLI workflow

Every unscoped `connect` creates a fresh remote session. The printed next steps carry its generated `--session`; keep that flag on every command when multiple processes or CI jobs share a host. The ambient active connection is only safe for one sequential workflow. Replacing a connection requires `connect ... --session <name> --force`; an unscoped `--force` creates a new connection and leaves existing sessions untouched.

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

For MCP-only operation, run the `connect` command in the same effective state directory before starting `agent-device mcp`. MCP exposes operational tools but not provider `connect` commands.

## Node.js client

Use direct client configuration when the Node process owns AWS credentials and selectors:

```ts
import { createAgentDeviceClient } from 'agent-device';

const client = createAgentDeviceClient({
  leaseProvider: 'aws-device-farm',
  platform: 'android',
  awsProjectArn: process.env.AWS_DEVICE_FARM_PROJECT_ARN,
  awsDeviceArn: process.env.AWS_DEVICE_FARM_DEVICE_ARN,
  awsAppArn: process.env.AWS_DEVICE_FARM_APP_ARN,
  awsRegion: process.env.AWS_REGION,
});

await client.apps.open({ app: 'com.example.app' });
const closed = await client.sessions.close();
```

## Artifacts and troubleshooting

After `close`, AWS Device Farm can return remote-access video and log artifacts once the provider finalizes them. Use `agent-device artifacts --json`, or look up a previous session explicitly:

```bash
agent-device artifacts <remote-access-session-arn> --provider aws-device-farm --json
```

If connect fails, use its reported `aws devicefarm get-*` error to check the credential chain, ARN, region, resource platform, or upload readiness. Allocation has not happened yet. If artifacts are pending immediately after `close`, retry the lookup.

On hosted WebDriver sessions, `fill` waits to witness text-entry focus before typing. If focus cannot be witnessed, it fails without sending keys. Use `snapshot -i` to confirm the target; if the driver cannot expose focus at all, use `press <target>` followed by `type <text>`, accepting that the destination cannot be verified.
