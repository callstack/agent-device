---
title: Device Clouds
description: Choose a hosted device provider for agent and CI workflows.
---

# Device Clouds

Use a device cloud or farm when an agent needs to drive a hosted mobile device without an interactive login. Pick the provider whose account and devices you use:

- [BrowserStack](/docs/browserstack): Android and iOS App Automate sessions over WebDriver.
- [AWS Device Farm](/docs/aws-device-farm): Android and iOS remote-access sessions through AWS.
- [TestMu AI](/docs/testmu): Android emulator, iOS simulator, and real-device sessions over WebDriver.
- [Limrun](/docs/limrun): direct iOS simulator and Android emulator instances.

## Compare providers

| | BrowserStack | AWS Device Farm | TestMu AI | Limrun |
| --- | --- | --- | --- | --- |
| Devices | Android and iOS real devices | Android and iOS real devices | Android emulators and iOS simulators by default; real devices with `--provider-device-type real` | Android emulators and iOS simulators |
| Ships as | Built in | Built in; needs the AWS CLI | The `@agent-device/testmu` plugin | Built in |
| Credentials | `BROWSERSTACK_USERNAME`, `BROWSERSTACK_ACCESS_KEY` | The AWS CLI credential chain, such as `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_REGION` | `LT_USERNAME`, `LT_ACCESS_KEY` | `LIMRUN_API_KEY` (optional `LIMRUN_REGION`), or `LIM_*_INSTANCE_*` for an existing instance |
| Device allocated on | `open` | `open` | `open` | First device command, such as `install` or `open` |
| App source | `--provider-app`: `bs://` reference, HTTP(S) URL, or local path | `--aws-app-arn` upload ARN; no install after allocation | `--provider-app`: `lt://` reference, HTTP(S) URL, or local path | `install <id> <path-or-url>`, or `open <asset-name>` for an uploaded asset |
| Artifacts after `close` | Video, Appium and device logs, dashboard and public links | Video and log files | Video, Appium, device, network, and command logs, screenshots, dashboard link | None |
| Port reverse | No; use BrowserStack Local | No | No | Android over ADB; not on iOS |

## Shared workflow

Every provider runs through the local `agent-device` daemon. `connect` checks your credentials and configuration, then saves non-secret connection state; it does not allocate a device. BrowserStack, AWS Device Farm, and TestMu AI allocate a hosted session on `open`. Limrun allocates an instance on the first device command, such as `install` or `open`.

Every provider follows the same steps:

1. Put provider credentials in CI secrets or another non-interactive credential source.
2. Run `agent-device connect <provider>` with the provider selectors.
3. Follow the printed next command to install or open the app.
4. Run normal device commands, then `agent-device close` and `agent-device disconnect`.

Each provider accepts only its own provider flags (`--provider-*` and `--aws-*`). A flag the provider does not use fails with `INVALID_ARGS` naming the flag, whether you pass it to `connect`, `client.leases.allocate()`, or a remote-config profile, so no setting is silently dropped.

The generated remote profiles are safe to store as non-secret configuration. They can include app IDs, ARNs, device names, OS versions, and labels, but never provider API keys, access keys, or AWS secret keys.

## Use a provider only through MCP

Run `agent-device connect <provider>` in the same effective state directory before you start `agent-device mcp`. MCP exposes device commands such as `open`, `snapshot`, `close`, and `artifacts`, but not provider `connect` or `disconnect`.

## Change credentials while the daemon runs

A running daemon keeps the BrowserStack, TestMu AI, and Limrun credentials it started with. If your shell holds different ones, the first command that allocates a device, such as `open`, refuses before it creates a session. Run `agent-device daemon stop` with the same `--state-dir`, then rerun the command. A shell that sets none of the provider's variables uses the daemon's credentials.

AWS Device Farm reads the AWS CLI credential chain instead, so this check does not apply to it.

## Fill text on hosted WebDriver sessions

On BrowserStack, AWS Device Farm, and TestMu AI, `fill` checks that the field received focus before it sends keys. If it cannot confirm focus, it fails without typing. Use `snapshot -i` to confirm the target. If the driver cannot report focus at all, use `press <target>` followed by `type <text>`, which sends text without confirming where it lands.

## Retrieve artifacts after close

After `close`, run `agent-device artifacts --json` to get the provider's video, log, and dashboard URLs. To look up an earlier session, pass its provider session ID:

```bash
agent-device artifacts <provider-session-id> --provider <provider> --json
```

Providers finalize video and log URLs after the session ends. If the lookup reports artifacts as pending right after `close`, retry it a little later.
