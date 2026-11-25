---
title: ADC
---

ADC provides Android phones and Android TVs. Install Android SDK Platform-Tools on the Mac or Linux host running the daemon. Each lease uses a private ADB server.

From a checkout containing the ADC plugin on `0.22`, you can build and install the plugin before its npm release.

```bash
pnpm --filter @agent-device/adc pack --pack-destination /tmp
agent-device plugins add /tmp/agent-device-adc-0.22.0-dev.tgz
```

### Rent a device

Create an ADC workspace API key under Cloud Devices on [Callstack Platform](https://platform.callstack.com). Set `ADC_API_KEY` in the daemon environment, then connect and open an app.

```bash
agent-device connect adc --platform android --target tv --session tv
agent-device open com.android.tv.settings --session tv
agent-device snapshot -i --session tv
agent-device disconnect --session tv
```

Use `--target mobile` for a phone. The provider verifies the workspace key at connect time, creates the lease on first use and releases it on teardown. Direct bookings have a two-hour maximum from creation. For a self-hosted ADC instance, set `ADC_API_URL` to its trusted HTTPS origin. Both connection modes verify the WebSocket endpoint against this origin.

### Attach to an existing lease

A broker creates a lease with its ADC workspace key and calls `POST /v2/leases/{id}/access` when the lease becomes active. Give the client the returned `websocket_url` as `ADC_ADB_WEBSOCKET_URL` and the lease's `token` as `ADC_LEASE_TOKEN`. Use a daemon environment containing only these scoped credentials for ADC. Start a separate daemon state directory for each attached lease.

Run the same connect, open and disconnect commands with the leased form factor. In attached mode agent-device opens a local ADB tunnel to the existing device. Disconnect closes the tunnel. The broker owns release and settlement. `connect adc` runs the installed plugin and connects over ADB. `connect cloud` uses the Device Router to select a provider.
