# Revyl

Use [Revyl](https://revyl.com) to run agent-device on hosted iOS simulators and Android emulators.
You need a Revyl API key and the `@agent-device/revyl` plugin. Revyl issues keys to its customers; a
partner integration gets one through Revyl's partner program.

Revyl is not a WebDriver grid. agent-device rents a device from Revyl's execution API and drives it
through the same device-proxy actions Revyl's own clients use, so there is no Appium session, no
`lt:options` capability set, and no Appium log to read afterwards.

## Install the plugin

```bash
agent-device plugins add @agent-device/revyl
```

The plugin is an optional npm package installed under `AGENT_DEVICE_HOME`. After you add or update
it, close open sessions and run `agent-device daemon stop` with the state directory you use; the
next device command loads the plugin.

## Set credentials and connect

```bash
export REVYL_API_KEY=...
agent-device connect revyl \
  --platform ios \
  --device "iPhone 16" \
  --provider-os-version 18.0 \
  --provider-app https://apps.example.com/MyApp-simulator.zip
```

`connect` authenticates against the Revyl backend with one cheap request and saves the profile. It
does not rent a device: Revyl picks and boots a device when the first device command allocates the
lease, usually `open`. `--device` and `--provider-os-version` are optional; without them Revyl picks
from its own pool and reports a device agent-device then uses. A model or OS version Revyl has no
device for is reported when the session starts, not by `connect`.

`--provider-app` is required and must be a public HTTPS URL. Revyl downloads and installs the build
when it starts the device, so a local path or a provider-specific app reference has no meaning
there. Pass the zipped `.app` for iOS the way Revyl expects it, and the `.apk` URL for Android.

`open` takes the app's installed bundle identifier or package name, not the file name in that URL.

```bash
agent-device open com.example.app
agent-device snapshot -i
agent-device click 'label="Continue"'
agent-device close
agent-device disconnect
```

`close` ends the app on the device. `disconnect`, and any daemon shutdown, ends the Revyl session, so
the device is returned. Revyl also releases an idle session on its own after its idle timeout.

## What works on a Revyl session

A Revyl session runs the commands that reach a device through Revyl's device actions:

- `snapshot` and `screenshot`. iOS reads the simulator's accessibility tree and Android reads its
  uiautomator dump, so `snapshot -i`, `--json`, and label and selector targeting work the same way they
  do on a local device.
- `click`, `press`, `double tap`, `longpress`, and `fill` by point or by snapshot reference, and
  `scroll` by direction. `scroll` sends one drag of the planned finger path, so `--pixels` and
  `--amount` mean the same distance they mean on a local device. Revyl's drag takes endpoints only, so
  `scroll --duration-ms` refuses with that reason rather than running the drag at a speed nobody chose;
  `fill --delay-ms` is paced by typing one character per pause.
- `open` (the session's app), `open` with a deep link or URL, and `close` for the app the session opened.
- `home`, and `back` on Android. iOS has no system back button; click the app's own back control.

The plugin refuses every other command with a reason that names the substitute. It does not
report a refused command as a success:

- `type` refuses and points at `fill`, because Revyl enters text at a point rather than into the
  field the platform happens to focus.
- `swipe` and `gesture` refuse. Use `scroll`, which plans the path itself and sends one drag.
- `keyboard`, `clipboard`, `settings`, `orientation`, `alert`, `fold`, `telephony`, and `tv-remote`
  are not supported.
- `install`, `apps`, `push`, `logs`, `network dump`, `artifacts`, and `recordings` are not supported
  by this version of the plugin. Use `--provider-app` to put the build on the device when the
  session starts.
- `port reverse` is unavailable. Publish your app server at a public HTTPS URL instead of pointing
  Metro at `localhost`.

`devices` lists only the device your own session rented.

## Run it in CI

The plugin reads only `REVYL_API_KEY` and the optional `REVYL_API_URL`, so one secret is enough:

```yaml
- run: npm install -g agent-device && agent-device plugins add @agent-device/revyl
- run: agent-device connect revyl --platform android --provider-app "$APP_URL"
- run: agent-device open com.example.app && agent-device snapshot -i
- run: agent-device disconnect
  if: always()
```

Keep the `disconnect`: it is what ends the rented device when a run fails before `close`.

A running daemon keeps the `REVYL_API_KEY` it started with. If your shell holds a different one, the
first command that allocates a device refuses before it rents one. Run `agent-device daemon stop`
with the same `--state-dir`, then rerun the command. See
[Change credentials while the daemon runs](/docs/device-clouds#change-credentials-while-the-daemon-runs).

To use a staging or private Revyl backend, set `REVYL_API_URL` to its origin, for example
`https://backend.example.com`. It must be HTTPS; plain HTTP is accepted only for a loopback address,
which is what a local fake of the API is for.

## Use it from JavaScript

Install the plugin package as a dependency of your host and pass it to a host you start yourself.
`startAgentDevice()` runs the daemon in your process and registers the plugin objects you hand it, so
no `plugins add` step and no `REVYL_API_KEY` in the environment are needed:

```ts
import { createAgentDeviceClient, startAgentDevice } from 'agent-device';
import revyl from '@agent-device/revyl';

const host = await startAgentDevice({
  stateDir: './.my-app/agent-device-state',
  plugins: [revyl({ apiKey: 'your-api-key', apiUrl: 'https://backend.example.com' })],
});

const scope = {
  tenant: 'revyl',
  runId: process.env.GITHUB_RUN_ID ?? 'local-run',
  leaseBackend: 'ios-instance',
  leaseProvider: 'revyl',
} as const;

const lease = await host.client.leases.allocate({
  ...scope,
  platform: 'ios',
  device: 'iPhone 16',
  providerOsVersion: '18.0',
  providerApp: 'https://apps.example.com/MyApp-simulator.zip',
});
const client = createAgentDeviceClient({ ...host.clientConfig, ...scope, leaseId: lease.leaseId });

try {
  await client.apps.open({ app: 'com.example.app' });
  await client.capture.snapshot({ interactiveOnly: true });
  await client.interactions.click({ selector: 'label="Continue"' });
} finally {
  // Releasing the lease ends the Revyl session, so a failure cannot leave a device rented.
  // The inner finally closes the host even when the release itself fails; otherwise the embedded
  // daemon stays alive and nothing retries the release.
  try {
    await host.client.leases.release({ ...scope, leaseId: lease.leaseId });
  } finally {
    await host.close();
  }
}
```

`apiUrl` is optional and only needed for a staging or private Revyl backend. Leaving both out makes
the plugin read `REVYL_API_KEY` from the environment, which is also the only path a CLI or MCP session
takes when the daemon loads the plugin from the plugin store.

## Troubleshoot

- `UNAUTHORIZED` from `connect`: `REVYL_API_KEY` is not a key that backend accepts, or `REVYL_API_URL`
  points at a different environment than the key was issued for.
- A start that never becomes ready reports `provider-not-ready` or `provider-start-failed` and stops
  the run it started, so a failed `open` does not leave a rented device. Retry, then check that Revyl
  has a device of the requested model and OS version.
- A device that Revyl released while your session was open reports `provider-session-gone`. Run
  `close` and `open` again to rent a fresh one.
