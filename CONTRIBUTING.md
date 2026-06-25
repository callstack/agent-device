# Contributing

Thanks for your interest in contributing to agent-device.

## Development

Requirements:

- Node.js 22+
- pnpm
- Android SDK tools (`adb`) for Android support
- Xcode (`simctl`/`devicectl`) for iOS support

Setup:

```bash
pnpm install
```

Build all CLIs and Xcode projects:

```bash
pnpm build:all
```

Apple XCTest builds now share a common helper script. `pnpm build:xcuitest:ios` and
`pnpm build:xcuitest:tvos` keep their existing cleanup behavior, while
`pnpm build:xcuitest:macos` reuses the existing DerivedData by default for faster local
iteration. Set `AGENT_DEVICE_IOS_CLEAN_DERIVED=1` when you need a clean macOS runner rebuild.

Run tests:

```bash
pnpm test
```

Targeted checks:

```bash
pnpm check:quick
pnpm check:unit
pnpm exec vitest run src/compat/maestro/__tests__/replay-flow.test.ts src/compat/__tests__/replay-input.test.ts
```

Code quality (fallow): CI runs `pnpm check:fallow --base "$FALLOW_BASE"`, a diff-based
audit of dead code, duplication, and complexity in the files your PR changes, compared
against the grandfathered baselines in `fallow-baselines/`. Locally, `pnpm fallow` runs
the same kind of audit against `origin/main` and is expected to pass on a clean tree;
`pnpm fallow:all` shows the full-project picture, including known legacy findings that
the baselines grandfather, so it reporting issues is normal. CRAP scores depend on
estimated test coverage, so a finding can occasionally be exposed — not introduced — by
your change. Run `pnpm fallow:baseline` to regenerate the baselines only when you are
intentionally accepting a finding.

- `pnpm fallow` — diff-based audit vs `origin/main` (what CI runs, with CI picking the PR base)
- `pnpm fallow:all` — full-tree summary, includes grandfathered legacy findings
- `pnpm fallow:baseline` — regenerate baselines (only to intentionally accept a finding)

Optional device selectors for tests:

- `ANDROID_DEVICE=Pixel_9_Pro_XL` or `ANDROID_SERIAL=emulator-5554`
- `IOS_DEVICE="iPhone 17 Pro"` or `IOS_UDID=<udid>`

## Test App and Maestro Compatibility

The Expo test app lives in `examples/test-app`. Install its dependencies once:

```bash
pnpm test-app:install
```

For Maestro compatibility, we currently have 15 parser/compat unit tests and one
top-level test-app Maestro flow, `examples/test-app/maestro/checkout-form.yaml`,
which includes `examples/test-app/maestro/helpers/open-checkout-form.yaml`.

Run only the parser/compat tests:

```bash
pnpm exec vitest run src/compat/maestro/__tests__/replay-flow.test.ts src/compat/__tests__/replay-input.test.ts
```

Run the Expo test-app flow on iOS:

```bash
pnpm test-app:ios -- --device "iPhone 17 Pro"
pnpm ad --session test-app-maestro open "Agent Device Tester" --platform ios --device "iPhone 17 Pro"
pnpm ad --session test-app-maestro wait "Agent Device Tester" 30000 --platform ios --device "iPhone 17 Pro"
pnpm test-app:maestro:ios -- --session test-app-maestro -- --device "iPhone 17 Pro"
```

`pnpm test-app:ios` keeps Metro in the foreground after launching the app. Leave
that terminal running and run the `agent-device` and Maestro commands from a
separate terminal.

When targeting a specific Android emulator or device, build and install the
development client on that same target before running Maestro:

```bash
pnpm test-app:android -- --device "$ANDROID_DEVICE"
pnpm test-app:maestro:android -- --session test-app-maestro -- --device "$ANDROID_DEVICE"
```

## Guidelines

- Keep dependencies minimal.
- Preserve the CLI’s agent-friendly JSON output.
- Ensure tests open and close sessions explicitly.
- Add/adjust integration tests when introducing new commands.
- Prefer built-in Node APIs over new packages.

## Issue Labels

Issue labels describe workflow state, not who will do the work. See
`docs/agents/triage-labels.md` for the label meanings and state flow.

## Reporting issues

Please include:

- OS and Node version
- Xcode/Android SDK versions (if relevant)
- Exact command and output

Thanks for helping improve agent-device.
