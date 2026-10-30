---
title: Limrun
description: Drive Limrun iOS simulators and Android emulators with agent-device.
---

Use Limrun to run agent-device on remote iOS simulators and Android emulators. You need a Limrun API key, or the URL and token of an instance someone else created. Limrun does not use local or physical-device selectors such as `--udid`, `--serial`, or `--device`.

## Set credentials and connect

Export your Limrun API key, for example from CI secrets. Set `LIMRUN_REGION` to pick a region.

```bash
export LIMRUN_API_KEY=...
agent-device connect limrun --platform android
```

`--platform android` or `--platform ios` selects the instance type. `connect` checks the credentials for that platform without creating an instance.

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

agent-device connect limrun --platform android
agent-device install com.example.app ./app.apk
agent-device open com.example.app --relaunch
agent-device snapshot -i
agent-device click 'label="Continue"'
agent-device close
agent-device disconnect
```

On Android, agent-device connects to Limrun over an ADB tunnel. Snapshots use the Android snapshot helper, installs upload the app through Limrun asset storage, and port reverse runs over ADB, including the usual reverse setup for a local Metro server.

On iOS, agent-device supports app lifecycle commands, snapshots, screenshots, taps, text input, scrolling, the home button, clipboard read and write, app installation, and system alerts. `alert get/wait/accept/dismiss` read the alert from the same element tree as snapshots and dispatch the selected button; a choice is pressed only when its English label states the asked-for action (`Allow`, `Don't Allow`, `Ask App Not to Track`, and similar), so a localized alert is reported but never pressed. For an alert it recognizes, Limrun uses the same English button preferences as local Apple XCTest: `Allow While Using App` outranks `Allow Once`; `Open`, `Done`, and `Confirm…` accept; `Keep Browsing`, `Deny`, and `Skip` dismiss. Equal-ranked choices and unknown labels refuse. Limrun needs at least two actionable buttons to recognize an alert. App-owned dialogs are not system alerts there, so use `snapshot -i` and then `press @ref` or a label selector for the visible control. `open --launch-args` relaunches the app with those arguments through simctl. iOS has no `port reverse`: that command is Android-only, because it runs over ADB. iOS still reaches a local Metro. The instance client's destination tunnel routes device `localhost` connections back to this machine, so while that tunnel is open the app reaches a Metro listening on the host. With `agent-device connect limrun --provider-network-logs`, the session opens that tunnel when the device is allocated, usually by the first `open`, and keeps it; see [Capture session network traffic](#capture-session-network-traffic). Otherwise give the app a publicly reachable HTTPS Metro endpoint.

On an iPhone, Limrun reports a native tab bar as one empty group. `snapshot` then hit-tests points across the bar and lists the tabs it finds under it, with their labels, frames, and selected state, so you can press a tab by label. If a hit-test fails, takes longer than 1.5 seconds, or the 24 hit-tests a snapshot allows run out before the bar is found, `snapshot` lists the bar without tabs and returns a warning.

On iOS, `settings` supports `appearance`, `permission`, `location`, and `clear-app-state`, with the same arguments as a local simulator. `clear-app-state` resets the app's data container through Limrun's soft reset. That reset relaunches the app once before agent-device stops it, so the app may run once after its data is cleared. `reset-keychain`, `wifi`, `airplane`, `mobile-data`, `faceid`, `touchid`, and `text-size` are unsupported, and you cannot read back any iOS setting. On Android, `settings mobile-data on|off` runs over the ADB tunnel like on a local device.

On iOS, `fill` taps the target, waits for that field to take text-entry focus, and replaces the focused field's value in one write. The write is the complete text, including an empty string that clears the field and characters that have no hardware key. It does not send key events, so key-event handlers may not run. Some apps, including Flutter forms, do not expose a globally focused element to Limrun. In those apps, `fill` can fail with `text_entry_value_write_failed` after focus is observed. Inspect the field before retrying; use `press` and `type` to send key events. If the tap does not focus a field, `fill` fails with `text_entry_focus_not_observed` and writes nothing. `type` sends key events to whichever field already has focus. `--delay-ms` on `type` enters one character at a time; `--delay-ms` has no effect on `fill`.

To drive Limrun only through MCP, see [Use a provider only through MCP](/docs/device-clouds#use-a-provider-only-through-mcp). For Limrun, `artifacts` lists the network capture file only when you connect with `--provider-network-logs`; otherwise there are no provider artifacts to fetch.

## Capture session network traffic

`--provider-network-logs` records the device's HTTP traffic into a HAR 1.2 file on the machine that runs agent-device. The file stays valid while the session runs, so you can read it with `jq` at any point.

Before you turn it on, know what the capture changes:

- Captured traffic leaves through the machine that runs agent-device, not the device's own network. Servers see that machine's public IP, each new connection takes longer, and the device loses the captured hosts if agent-device stops. On CI, the traffic leaves from the CI runner.
- The HAR holds raw requests and responses, including headers, cookies, tokens, and bodies. Treat it as a secret: keep it out of logs, bug reports, and build artifacts that others can read.
- Certificate-pinned hosts refuse the connection, and an app that resolves names over DNS-over-HTTPS bypasses the capture.
- HTTPS hosts that don't support HTTP/2 fail to connect while the capture runs.
- Each request and response body is cut to 64 KiB. Once the file would pass 8 MiB, the oldest entries are dropped, and the failure summary reports them as `har-truncated`.

Pass your app's API hosts with `--provider-network-hosts`, then open the app after you connect:

```bash
agent-device connect limrun --platform ios --provider-network-logs \
  --provider-network-hosts "api.example.com,*.cdn.example.com,localhost:8081"
agent-device open com.example.app
agent-device artifacts      # prints the HAR path
jq -r '.log.entries[] | "\(.response.status) \(.request.method) \(.request.url)"' <har-path>
agent-device close          # prints the HAR path again
agent-device disconnect
```

`--provider-network-hosts` takes exact hosts, wildcards such as `*.example.com`, and `localhost:<port>` routes. Keep `localhost:8081`, or your Metro port, in the list when the app loads its bundle from a local Metro server. Without `--provider-network-hosts`, the capture covers every `.com`, `.org`, `.app`, `.net`, `.io`, and `.dev` host plus `localhost:8081`. Operating system traffic then fills most of the file, and hosts under other domains, such as `.co`, `.ai`, or country domains, are not captured.

The file is `<state-dir>/network-har/<instance-id>-<lease-id>.har`, readable only by your user. `agent-device artifacts` lists it during the session and after `close`. agent-device keeps the files of the 32 most recent captures that have stopped and deletes older ones; files from a daemon that has stopped stay until you delete them. If the capture can't start, for example because a `--provider-network-hosts` entry is not a valid host, `artifacts` reports the network artifact as `unavailable` with the reason.

### When a request fails or hangs

A request that can't reach its host still appears in the HAR with status `0`. `artifacts` and `close` also print a failure summary after the HAR path:

```text
Network capture failures: 9; inspection-error 8, latest bag.itunes.apple.com:443 (terminate app TLS: EOF); request-failed 1, latest api.example.com:443 (tunnel client could not open the destination: client_dial_failed); last dial failure tls_handshake_failed
```

- `request-failed`: the request reached the capture, but its host didn't resolve, refused, timed out, or failed the TLS handshake. Check that the machine running agent-device can reach the host.
- `inspection-error`: the capture couldn't read a connection. This is usually a certificate-pinned host. System hosts, such as Apple's, report these in every session.
- `inspection-gap` and `inspection-stream-error`: the HAR misses requests. Reconnect if you need a complete file.
- `har-truncated`: the oldest entries were dropped to keep the file under 8 MiB. Narrow `--provider-network-hosts` to keep more of your app's traffic.
- `har-write-failed`: the file could not be written, so it lags the traffic. Check the free disk space on the machine that runs agent-device.
- `last dial failure`: the reason Limrun reports for the most recent failed connection, such as `dns_not_found`, `connection_refused`, `client_timeout`, or `tls_handshake_failed`.

Occasionally, requests skip the capture: they are missing from the HAR and from the failure summary. This affects the first request after the device is allocated, or now and then a whole session. If a request you expect is missing, repeat it. If the HAR stays empty while the app makes requests, run `close` and `disconnect`, then connect again.

`artifacts --json` returns the same report, with counts and the latest failures of each kind, in `data.cloudArtifacts[0].metadata.tunnelFailures`.

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

A provider that reaches a harness-owned instance through the Node.js client allocates a Limrun lease in `acquire` and releases that same lease in `release`. Put the returned `lease.leaseId` on the client scope, and pass that same id to `leases.release`. Start the daemon with the instance URL and token (`LIM_IOS_INSTANCE_URL` and `LIM_IOS_INSTANCE_TOKEN`). `leases.allocate` attaches to that instance. `leases.release` returns `{ released, provider }`. Neither call creates or deletes the instance. Allocate with `retainOnClose: true` because the provider releases the lease itself: without it, a session `close` before `release` ends the lease and `leases.release` returns `released: false`. A retained lease still expires after its `ttlMs`, so keep heartbeating it between sessions.

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

## Get artifacts and troubleshoot

For Limrun, `agent-device artifacts` lists only the `--provider-network-logs` HAR file. If a page hangs while the capture runs, read the failure summary that `artifacts` prints; see [When a request fails or hangs](#when-a-request-fails-or-hangs). If `connect` fails, check `LIMRUN_API_KEY` and the optional `LIMRUN_REGION`. For an existing instance, check its URL and token variables, and that the instance is still running.
