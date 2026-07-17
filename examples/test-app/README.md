# Agent Device Tester

`Agent Device Tester` is a minimal Expo Router fixture app for `agent-device` and `skillgym` experiments.

It is intentionally small, but each surface is dense with durable accessibility targets so a few screens cover a large share of the workflows we care about.

## Why this app exists

- It gives `agent-device` a stable React Native target that we control.
- It makes `skillgym` prompts concrete: the agent can inspect real app files instead of answering against an imagined UI.
- It keeps the number of screens low while still covering roughly 50 practical interaction and verification cases.

## Screens

- `Home`: visible-text checks, dismissible banner, modal open/close, async loading, status badge, switch state
- `Catalog`: search debounce, filter chips, long-list scroll, favorite toggles, cart updates, drill-in navigation
- `Product detail`: back navigation, quantity stepper, multiline notes, save action
- `Checkout form`: required-field validation, fill vs type, checkbox state, choice groups, keyboard dismiss, success summary
- `Settings`: switch rows, accordion content, loading and error states, retry flow, destructive-confirm modal

Navigation uses Expo Router native bottom tabs, so the tab bar itself is also part of the test surface.

## Coverage map

These are the main case families this app can support without adding more screens:

- app open and close
- visible text verification with plain `snapshot`
- interactive discovery with `snapshot -i`
- `press` on stable buttons, pills, and rows
- `fill` on single-line and multiline fields
- `type` after focus for append flows
- `get text` on headings, badges, summaries, and accordion content
- `is visible` and `is exists` assertions
- `wait` for async loading and success states
- `diff snapshot` after dismissals and submits
- long-list scrolling and `scrollintoview`
- selector-based navigation across repeated cards
- modal open, cancel, and confirm flows
- switch and checkbox state changes
- validation-error and recovery loops
- retryable error banners
- cart counters and quantity changes
- screenshot and recording proof capture

## Run locally

This fixture uses an Expo development build, not Expo Go. Expo's development-build
workflow installs `expo-dev-client`, builds the native app with `expo run:ios` or
`expo run:android`, and then serves JavaScript from Metro with `expo start`.
The app declares `@expo/dom-webview` directly to keep Expo's development runtime
on the SDK 56 native module; Android verification failed when the dev client
resolved an older transitive copy.

### Build cache

Local `pnpm test-app:ios` / `test-app:android` cache the native build on disk via
the [`expo-build-disk-cache`](https://github.com/WookieFPV/expo-build-disk-cache)
provider (configured in `app.config.js`), keyed by the
[Expo fingerprint](https://docs.expo.dev/versions/latest/sdk/fingerprint/). A
second run with no native change reuses the first build instead of recompiling;
editing screens never needs a rebuild, because Metro serves JavaScript at
runtime. A fresh checkout still pays for the first native build — the disk cache
only spares you the repeats.

That fingerprint is why `/ios` and `/android` are gitignored: ignoring the
prebuild output is what makes @expo/fingerprint treat this app as CNG and skip
hashing it. Un-ignore them and the fingerprint starts describing your machine
rather than the project.

CI does not use the disk cache. `.github/workflows/test-app-build-cache.yml`
builds a **Release** binary (JS embedded, no Metro) per platform when the
fingerprint has no artifact yet, and publishes it as a GitHub Actions artifact
named `fingerprint.<hash>.<platform>`. Jobs that drive the app install it through
`.github/actions/setup-fixture-app`, which downloads that artifact and refreshes
its JS with `@expo/repack-app` (~seconds) — so a JS-only change reuses the same
native binary. A consuming job needs `permissions: actions: read`.

### iOS simulator

From the repo root, install dependencies and run the development build on the
target simulator:

```bash
pnpm test-app:install
pnpm test-app:ios -- --device "iPhone 17 Pro"
```

`expo run:*` keeps Metro in the foreground after launching the app. Leave that
terminal running, then use a separate terminal for `agent-device` or Maestro
commands.

### iOS physical device

Use the physical device name from `agent-device devices --platform ios` or
`xcrun devicectl list devices`. Keep the `expo run:ios` terminal running so
Metro stays visible to the development build:

```bash
pnpm test-app:install
pnpm test-app:ios -- --device "<physical device name>"
```

Then verify the installed development build from another terminal with the same
physical device identifier:

```bash
agent-device open com.callstack.agentdevicelab --platform ios --udid "<physical udid>" --session test-app-physical
agent-device snapshot -i --platform ios --udid "<physical udid>" --session test-app-physical
```

The snapshot should show the `Agent Device Tester` home screen, for example the
`Agent Device Tester` heading and tab bar. An already installed
`com.callstack.agentdevicelab` is not enough evidence by itself: confirm Metro
is running for the development build and verify the visible app surface before
using the session for manual logs, network, replay, or interaction checks. Close
the same session when verification is complete:

```bash
agent-device close --platform ios --udid "<physical udid>" --session test-app-physical
```

#### AccessorySetupKit picker fixture

The Settings tab links to a dedicated **Accessory setup lab** backed by a local Expo module. The
development client uses this fixed test service UUID, so no build-time environment variables are
required:

```text
FFF0
```

Advertise that service from the test accessory, build with the normal physical-device command above,
then open **Settings → Open accessory setup lab**. The picker requires physical iOS 18+ hardware; use
the normal session hygiene above when validating its snapshot, wait, and selector paths.

### Android emulator or device

Install dependencies and run the development build on the target Android
emulator or device:

```bash
pnpm test-app:install
pnpm test-app:android -- --device "$ANDROID_DEVICE"
```

For Android app/package launches connected to local Metro, run `adb reverse`
for the Metro port when needed before opening the app with `agent-device`.

### Running from the app folder

If you prefer to work from inside the app folder:

```bash
cd examples/test-app
pnpm install --ignore-workspace
pnpm ios
```

Or on Android:

```bash
cd examples/test-app
pnpm install --ignore-workspace
pnpm android
```

After the first native build is installed, use `pnpm test-app:start` when you only
need to restart Metro for JavaScript or TypeScript changes. `test-app:start`
starts Metro only; it does not build, install, or prove a physical device is
running the development build. Once the app is running and verified with
`snapshot -i`, use `agent-device` against `Agent Device Tester` like any other
target app.

### Non-default Metro ports

If the default Metro port is already in use, start Metro on another port. Do not
reinstall the native development build just to change the JavaScript server port:

```bash
pnpm test-app:start -- --port 8082
```

If you are building and installing for the first time in that terminal, Expo's
`run:ios` and `run:android` commands also accept `--port`:

```bash
pnpm test-app:ios -- --device "<device name>" --port 8082
pnpm test-app:android -- --device "$ANDROID_DEVICE" --port 8082
```

After the development build is installed, keep using the same native app. The
current `agent-device open` CLI does not accept `--metro-host` or `--metro-port`;
open the app normally, then use the Metro command surface for Metro-specific
actions:

```bash
agent-device metro prepare --project-root examples/test-app --kind expo --port 8082 --public-base-url http://127.0.0.1:8082
agent-device metro reload --metro-host 127.0.0.1 --metro-port 8082
```

Use `metro prepare` when you want `agent-device` to start or reuse Metro and
print the runtime URLs. Use `metro reload` when Metro is already running and the
installed development build is connected to that server. For Android local
device/emulator runs, also run `adb reverse tcp:8082 tcp:8082` when the device
needs host port forwarding.

## Local Agent Device suites

The repo includes two local suites for iterating on the fixture app:

```bash
pnpm test-app:replay:ios
pnpm test-app:replay:android
```

These run the `.ad` replay suite in `examples/test-app/replays`.

The iOS `gesture-lab.ad` and Android `gesture-lab-android.ad` replays verify
`gesture pan`, `gesture fling`, `gesture pinch`, and `gesture rotate` against the
gesture metrics rendered by the Home screen. They also prove that the default pan
does not activate an exactly-two-pointer recognizer, while
`gesture pan ... --pointer-count 2` does without changing pinch or rotation state.

Each gesture replay relaunches the app before its combined `gesture transform`
canary, verifies the clean pan/pinch/rotate state, then checks that one atomic
two-pointer gesture changes all three semantic states. On Android, these checks
are intentionally qualitative because recognizers can report non-exact centroid,
scale, and rotation values for one simultaneous two-finger gesture.

To target a specific iOS simulator or an installed Expo development build, run the
underlying command directly so global flags stay before replay inputs:

```bash
node bin/agent-device.mjs test examples/test-app/replays \
  --platform ios \
  --device "iPhone 17 Pro" \
  --env APP_TARGET=com.callstack.agentdevicelab \
  --env APP_URL=<project-url> \
  --artifacts-dir .tmp/test-app-replay/ios
```

Omit `APP_URL` when the installed development build can discover the local Metro
server from its launcher.

The Maestro prototype suite lives in `examples/test-app/maestro` and runs through
`agent-device replay --maestro`:

```bash
pnpm test-app:maestro:ios
pnpm test-app:maestro:android
```

The Maestro flow includes `launchApp`, so the suite launches the app inside each
test attempt. Start Metro first when the installed development build needs the
local bundle.

The suite intentionally covers the compat layer syntax used by public Maestro suites:
`runFlow` file/inline blocks, `when.platform`, config hooks, deterministic `repeat.times`,
flow `env`, selectors, input, assertions, and swipe.
