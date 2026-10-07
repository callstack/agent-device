---
title: AWS Device Farm
description: Drive AWS Device Farm remote-access sessions with agent-device.
---

# AWS Device Farm

Use AWS Device Farm to run agent-device on hosted Android and iOS devices through remote-access WebDriver sessions. You need an AWS account with a Device Farm project and the AWS CLI installed. AWS Device Farm does not cover Vega OS: agent-device rejects a Vega Fire TV ARN. For Vega, use a local Vega Virtual Device (VVD).

## Set credentials and connect

agent-device runs `aws devicefarm ...`, so it uses the AWS CLI credential provider chain and works with any non-interactive AWS CLI credential source in CI. You do not need `aws login`. See the [AWS CLI environment variable reference](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-envvars.html) for supported credential sources.

Use short-lived CI credentials instead of long-lived IAM user keys. In GitHub Actions, use OIDC to assume an IAM role and let the action export the standard AWS environment variables. AWS documents [IAM OIDC providers](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_providers_create_oidc.html), and the official [`configure-aws-credentials` action](https://github.com/aws-actions/configure-aws-credentials) documents the GitHub Actions setup.

For example, a CI job can set:

```bash
export AWS_REGION=us-west-2
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
export AWS_SESSION_TOKEN=... # present for temporary credentials
```

AWS web identity flows can use:

```bash
export AWS_ROLE_ARN=arn:aws:iam::<account-id>:role/<role-name>
export AWS_WEB_IDENTITY_TOKEN_FILE=/path/to/token
export AWS_REGION=us-west-2
```

Connect with the Device Farm project, the device, and an optional app upload:

```bash
agent-device connect aws-device-farm \
  --platform android \
  --aws-project-arn arn:aws:devicefarm:us-west-2:<account-id>:project:<project-id> \
  --aws-device-arn arn:aws:devicefarm:us-west-2::device:<device-id> \
  --aws-app-arn arn:aws:devicefarm:us-west-2:<account-id>:upload:<upload-id>
```

Omit `--aws-app-arn` when the remote-access session does not need an uploaded app. You can also pass the ARNs through environment variables:

```bash
export AWS_DEVICE_FARM_PROJECT_ARN=...
export AWS_DEVICE_FARM_DEVICE_ARN=...
export AWS_DEVICE_FARM_APP_ARN=...
```

agent-device also accepts `AGENT_DEVICE_AWS_DEVICE_FARM_PROJECT_ARN`, `AGENT_DEVICE_AWS_DEVICE_FARM_DEVICE_ARN`, and `AGENT_DEVICE_AWS_DEVICE_FARM_APP_ARN` as aliases.

`connect` makes read-only `get-project`, `get-device`, and, when you pass an app, `get-upload` calls. It rejects a device or app for the wrong platform, and an app upload that is not ready. You cannot install an app once the remote-access session is allocated. When an app is required, run the printed reconnect command, including `--session <name> --force`, before `open`.

## Run a session from the CLI

Every `connect` without `--session` creates a new connection, and the printed next steps include its generated `--session`. Keep that flag on every command when several processes or CI jobs share a host; the active connection is safe only for one sequential workflow. To replace a named connection, run `connect ... --session <name> --force`. `--force` without `--session` creates a new connection and leaves existing sessions untouched.

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

To use AWS Device Farm only through MCP, run `connect` in the same effective state directory before you start `agent-device mcp`. MCP exposes device commands such as `open`, `snapshot`, `close`, and `artifacts`, but not provider `connect` commands.

## Use the Node.js client

Configure the client directly when your Node.js process manages the AWS credentials and selectors:

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

## Get artifacts and troubleshoot

After `close`, AWS Device Farm can return remote-access video and log artifacts once it finalizes them. Run `agent-device artifacts --json`, or look up an earlier session by its ARN:

```bash
agent-device artifacts <remote-access-session-arn> --provider aws-device-farm --json
```

If `connect` fails, use the reported `aws devicefarm get-*` error to check the credential chain, ARN, region, resource platform, or upload readiness. A failed `connect` has not allocated a device yet. If artifacts are still pending right after `close`, retry the lookup.

On hosted WebDriver sessions, `fill` checks that the field received focus before it sends keys. If it cannot confirm focus, it fails without typing. Use `snapshot -i` to confirm the target. If the driver cannot report focus at all, use `press <target>` followed by `type <text>`, which sends text without confirming where it lands.

On a screen that never goes still, such as a looping video, a live ticker, or continuous animation, `snapshot -i` can time out while `screenshot` of the same screen still returns. On a metered device every second of that read is billed, so do not retry the snapshot in a loop. Take a screenshot instead and drive from `@refs` an earlier snapshot captured. `--depth` trims the tree after it arrives, so it cannot shorten a read that never finishes. See [Snapshots](/docs/snapshots) for details.
