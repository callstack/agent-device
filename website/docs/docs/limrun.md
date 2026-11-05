---
title: Limrun
description: Drive Limrun iOS simulators and Android emulators with agent-device.
---

Use Limrun to run agent-device on remote iOS simulators and Android emulators. You need a Limrun API key, or the URL and token of an instance someone else created. Limrun does not use local or physical-device selectors such as `--udid`, `--serial`, or `--device`.

## Set credentials and connect

Export your Limrun API key, for example from CI secrets. Set `LIMRUN_REGION` to pick a region.

```bash
export LIMRUN_API_KEY=...
export AGENT_DEVICE_SESSION=checkout-android
agent-device connect limrun --platform android
```

`--platform android` or `--platform ios` selects the instance type. `connect` checks the credentials for that platform without creating an instance. Set `AGENT_DEVICE_SESSION` to a name for your agent or CI job. Every command on a Limrun connection needs that session name, either through this variable, `--session`, or your config.

Requests agent-device makes with your API key, including instance creation, start their `User-Agent` with `agent-device-cli/<version>` so Limrun can attribute them to agent-device for revenue sharing.

## Drive an existing instance

An agent in a sandbox can drive an instance that someone else created, such as the instance behind a live preview, without your organization's API key. Create the instance where the API key lives, then give the sandbox that instance's URL and token from its `status`:

| Platform | Environment variables |
| --- | --- |
| iOS | `LIM_IOS_INSTANCE_URL` (`status.apiUrl`), `LIM_IOS_INSTANCE_TOKEN` (`status.token`) |
| Android | `LIM_ANDROID_INSTANCE_URL` (`status.apiUrl`), `LIM_ANDROID_INSTANCE_TOKEN` (`status.token`), `LIM_ANDROID_INSTANCE_ADB_URL` (`status.adbWebSocketUrl`) |

The `lim` CLI reads the same variables, so one set works for both tools. Set all of a platform's variables or none. With a partial set, `connect` fails, and the daemon registers without Limrun, lists it as `failed` in `agent-device daemon status`, and records `provider_plugin_failed` in `daemon.log`.

```bash
export LIM_IOS_INSTANCE_URL=...
export LIM_IOS_INSTANCE_TOKEN=...
export AGENT_DEVICE_SESSION=preview-ios

agent-device connect limrun --platform ios
agent-device open com.example.app
agent-device snapshot -i
agent-device disconnect
```

`connect` checks the instance credentials. agent-device never creates or deletes that instance: `disconnect` leaves it running, and its owner deletes it. When a platform's instance variables are set, they take precedence over `LIMRUN_API_KEY` for that platform.

On an attached Android instance, agent-device does not replace an existing port reverse mapping. If the owner already maps a device port, such as `tcp:8081` for their Metro server, a reverse to that port fails and the owner's mapping stays in place. The error has `details.reason: 'android_port_reverse_rebind_refused'` when `adb reverse --list` shows the mapping; otherwise it is a plain ADB failure.

If your shell's account variables, or its instance variables for the platform you lease, differ from the ones the daemon started with, the first `install` or `open` refuses before it creates or attaches to an instance. See [Change credentials while the daemon runs](/docs/device-clouds#change-credentials-while-the-daemon-runs).

`install`, and `apps` before the first `open`, need `LIMRUN_API_KEY` because they use Limrun asset storage. After `open`, `apps` lists the apps installed on the instance without the key. Install your app before you hand over the instance. From the Node.js runtime, `getDeviceSession(device).installRemoteApp(url)` installs from a signed asset URL without the API key.

## Keep idle sessions alive

Limrun ends an instance after its inactivity timeout, which an idle session can reach while a model thinks between steps. Set `LIMRUN_KEEP_ALIVE=1` (or `true`) to ping the instance every 30 seconds while a session is open. Keep-alive is off by default. In the Node.js runtime, pass `keepAlive: true`.

## Run a session from the CLI

A new Limrun instance does not contain your app. Run `install <package-or-bundle-id> <app-path-or-url>` before `open`. `install` allocates the instance when needed, so you do not need to run `devices` first.

```bash
export LIMRUN_API_KEY=...
export AGENT_DEVICE_SESSION=checkout-android

agent-device connect limrun --platform android
agent-device install com.example.app ./app.apk
agent-device open com.example.app --relaunch
agent-device snapshot -i
agent-device click 'label="Continue"'
agent-device close
agent-device disconnect
```

For a new iOS simulator, install a simulator build of your app:

```bash
export LIMRUN_API_KEY=...
export AGENT_DEVICE_SESSION=checkout-ios

agent-device connect limrun --platform ios
agent-device install com.example.app ./MyApp.app
agent-device open com.example.app
agent-device snapshot -i
agent-device screenshot ./screen.png
agent-device record start ./session.mp4
agent-device click 'label="Continue"'
agent-device record stop
agent-device close
agent-device disconnect
```

Use a selector from your app's snapshot in place of `Continue`.

On Android, agent-device connects to Limrun over an ADB tunnel. Snapshots use the Android snapshot helper, installs upload the app through Limrun asset storage, and port reverse runs over ADB, including the usual reverse setup for a local Metro server.

## Use an iOS simulator

Use the same snapshot, selector, text-entry, gesture, navigation, clipboard, and alert commands as on a local iOS simulator. Limrun iOS uses the agent-device XCTest runner, so snapshots include the same tab contents, hierarchy, and keyboard observations as local XCTest snapshots. `fill` replaces text and `type` appends it; both support `--delay-ms`.

Use a stable agent-device release. It downloads and starts the matching runner automatically. You do not need local Xcode or any runner network configuration. Stop Appium or other XCTest sessions on the simulator before you start, because only one XCTest run can use it at a time. Limrun limits each XCTest run to one hour; close and reopen your session when it reaches that limit.

If startup fails with `limrun_xctest_slot_occupied`, stop the agent-device or Appium session that owns the simulator and wait for its XCTest run to end. If that client has exited and the slot remains occupied, recreate the Limrun instance. If a snapshot fails with `limrun_runner_snapshot_unavailable`, close and reopen your agent-device session. Recreate the instance if captures still fail. Do not reuse snapshot references after a failed capture.

Open your app before taking a snapshot. Snapshots target the app you opened in that session. In the SDK, you can also pass `appBundleId` to the snapshot call. A snapshot without a target app fails.

`install` leaves your app stopped. Use `open` to launch it. To change launch arguments on an app that is already running, use `open --relaunch --launch-args`. Screenshots download as lossless PNG files, and recording downloads the finished MP4 when you stop it. Push notifications use the same command and payload format as local simulators.

If you use a nightly or unpublished agent-device build, obtain a matching packaged iOS runner from the build's maintainer. Set `AGENT_DEVICE_LIMRUN_IOS_RUNNER_APP` to the extracted `.app` path before starting agent-device. If the daemon is already running, stop it with `agent-device daemon stop` using the same `--state-dir`, then reconnect.

## Connect an iOS app to Metro

An installed Expo dev client can open with the same automatic launch URL discovery as a local simulator when its `exp+` scheme has one installed owner and Metro runtime information is available. An explicit launch URL takes precedence. If agent-device cannot verify which app owns a custom URL scheme, it leaves the launch confirmation for you to inspect and answer with the alert commands.

For a local Metro server, connect with `--provider-network-logs` and include `localhost:8081`, or your Metro port, in `--provider-network-hosts`. While the session is open, the app can reach that port on the machine running agent-device. See [Capture session network traffic](#capture-session-network-traffic) for the network changes this option makes. Otherwise, use a publicly reachable HTTPS Metro endpoint. `port reverse` is Android-only.

## Read iOS app logs

After opening your app, use `logs start` to collect its stdout, stderr, and matching simulator logs. Use `open <app> --launch-console <path>` to capture its initial launch output. Runner logs contain the test results Limrun provides, but native XCTest stdout is unavailable.

Remote simulator logs do not include sender or process image paths. Filters that rely only on those fields cannot match remotely.

## Change simulator settings

On iOS, `settings` supports `appearance`, `permission`, `location`, `wifi`, `airplane`, `faceid`, `touchid`, `text-size`, and `clear-app-state`, with the same arguments as a local simulator. You can also read the current text size.

Wi-Fi and airplane settings change the status-bar appearance; they do not disconnect the simulator. `clear-app-state` stops your app and removes its data. Use `open` when you are ready to launch it again. `reset-keychain` and `mobile-data` are unavailable on Limrun iOS. On Android, `settings mobile-data on|off` works as on a local device. Fold commands are unavailable on Limrun.

To drive Limrun only through MCP, see [Use a provider only through MCP](/docs/device-clouds#use-a-provider-only-through-mcp). For Limrun, `artifacts` lists the network capture file only when you connect with `--provider-network-logs`; otherwise there are no provider artifacts to fetch.

## Capture session network traffic

Use `--provider-network-logs` when you debug an app's network requests on a remote Limrun device. The device's traffic is captured while the session runs. `agent-device artifacts` and `close` write it as a HAR 1.2 file and print its path.

Before you turn it on, know what the capture changes:

- Captured traffic leaves through the machine that runs agent-device, not the device's own network. Servers see that machine's public IP. On CI, the traffic leaves from the CI runner.
- The HAR holds raw requests and responses, including headers, cookies, tokens, and bodies. Treat it as a secret. Keep it out of logs, bug reports, and build artifacts that others can read.
- Some hosts can't be captured: certificate-pinned hosts refuse the connection, apps that resolve names over DNS-over-HTTPS bypass the capture, and HTTPS hosts that don't support HTTP/2 fail to connect.
- Each body is cut to 64 KiB, and the HAR keeps the latest 500 requests.

Pass your app's API hosts with `--provider-network-hosts`, then open the app after you connect:

```bash
export AGENT_DEVICE_SESSION=checkout-ios
agent-device connect limrun --platform ios --provider-network-logs \
  --provider-network-hosts "api.example.com,*.cdn.example.com,localhost:8081"
agent-device open com.example.app
agent-device artifacts      # writes the HAR and prints its path
jq -r '.log.entries[] | "\(.response.status) \(.request.method) \(.request.url)"' <har-path>
agent-device close          # writes the HAR again and prints its path
agent-device disconnect
```

`--provider-network-hosts` takes exact hosts, wildcards such as `*.example.com`, and `localhost:<port>` routes. Keep `localhost:8081`, or your Metro port, in the list when the app loads its bundle from a local Metro server. Without `--provider-network-hosts`, the capture covers every `.com`, `.org`, `.app`, `.net`, `.io`, and `.dev` host plus `localhost:8081`. System traffic then fills most of the file.

The file is `<state-dir>/network-har/<lease-id>.har`, and only your user can read it. It stays until you delete it. If the capture can't start, for example because a `--provider-network-hosts` entry is not a valid host, `artifacts` reports the network artifact as `unavailable` with the reason.

A request that can't reach its host appears in the HAR with status `0`. When the capture has failures, `artifacts` and `close` print a summary after the HAR path:

```text
Network capture failures: 2; last request-failed api.example.com:443; last dial failure dns_not_found
```

The count includes these kinds: `request-failed` (the host didn't resolve, refused, timed out, or failed TLS), `inspection-error` (usually a certificate-pinned host), and `inspection-gap` and `inspection-stream-error` (the HAR misses requests). `last dial failure` is Limrun's reason for the most recent failed connection. The HAR keeps the latest 500 requests, with each body cut to 64 KiB, so a capture can hold tens of MB in the daemon. When older requests left the HAR, the summary says how many, and the count doesn't include them. `artifacts --json` returns the same values in `data.cloudArtifacts[0].metadata.failures`.

Now and then, a request skips the capture: it is missing from the HAR and from the failure count. If a request you expect is missing, repeat it. If the HAR stays empty while the app makes requests, run `close` and `disconnect`, then connect again.

## Embed the Node.js runtime

A Node.js bridge, such as agent-device-cloud, can embed agent-device's Limrun runtime:

```ts
import { LimrunRuntime } from 'agent-device/limrun';

const apiKey = process.env.LIMRUN_API_KEY;
if (!apiKey) throw new Error('LIMRUN_API_KEY is required');

const runtime = new LimrunRuntime({
  apiKey,
  region: process.env.LIMRUN_REGION,
});
```

To drive existing instances, pass `instances: { ios: { apiUrl, token } }` (Android also takes `adbUrl`), with or without `apiKey`. The runtime never creates or deletes instances for a platform listed there.

A provider that reaches a harness-owned instance through the Node.js client allocates a Limrun lease in `acquire` and releases that same lease in `release`. Put the returned `lease.leaseId` on the client scope, and pass that same id to `leases.release`. Start the daemon with the instance URL and token (`LIM_IOS_INSTANCE_URL` and `LIM_IOS_INSTANCE_TOKEN`). `leases.allocate` attaches to that instance. `leases.release` returns `{ released, provider }`. Neither call creates or deletes the instance. Allocate with `retainOnClose: true` because the provider releases the lease itself: without it, a session `close` before `release` ends the lease and `leases.release` returns `released: false`. A retained lease still expires after its `ttlMs`, so keep heartbeating it between sessions. On iOS, a retained lease can reuse a healthy runner between sessions in the same daemon. Releasing the lease or stopping the daemon stops the runner. A new daemon cannot adopt it.

```ts
import { createAgentDeviceClient } from 'agent-device';

const scope = {
  tenant: 'limrun',
  runId: process.env.GITHUB_RUN_ID ?? 'local-run',
  leaseBackend: 'ios-instance',
  leaseProvider: 'limrun',
} as const;

const provider = {
  acquire: async (req: { slot: string }) => {
    const lease = await createAgentDeviceClient({ session: `lease-${req.slot}` }).leases.allocate({
      ...scope,
      platform: 'ios',
      retainOnClose: true,
    });
    return {
      id: lease.leaseId,
      client: { ...scope, leaseId: lease.leaseId, sessionIsolation: 'tenant' as const },
    };
  },
  release: async (lease: { id: string }) => {
    await createAgentDeviceClient({}).leases.release({ ...scope, leaseId: lease.id });
  },
};
```

After allocating a lease, call `runtime.getDeviceSession(device)` to get the allocated device's capabilities: app inventory, foreground state where Limrun exposes it, key input, bounded log reads, recording, remote asset installation, and the interactor. On Android it also exposes agent-device's `AndroidAdbProvider` for helpers and reversible port forwarding. On iOS it exposes a typed `simctl` execution handle so your bridge can own runner lifecycle and launch policy. The runtime does not expose raw Limrun clients.

## Record the screen

Use `record start video.mp4` and `record stop` in an open session. The recording runs on Limrun,
and `record stop` downloads the finished MP4. Each agent-device recording has its own Limrun
recording ID, so stopping it leaves other recordings on that instance running. Concurrent
recordings must use compatible encoder settings, including the same quality.

`--quality medium|high` is supported. `--fps`, `--hide-touches`, and recording recovery after a
daemon restart are not supported. Every recording scope captures the whole device screen.

## Get artifacts and troubleshoot

For Limrun, `agent-device artifacts` lists only the `--provider-network-logs` HAR file. If a page hangs while the capture runs, read the failure summary that `artifacts` prints; see [Capture session network traffic](#capture-session-network-traffic). If `connect` fails, check `LIMRUN_API_KEY` and the optional `LIMRUN_REGION`. For an existing instance, check its URL and token variables, and that the instance is still running.
