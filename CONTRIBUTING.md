# Contributing

Thanks for your interest in contributing to agent-device.

## Development

Requirements:

- Node.js 22+
- pnpm, activated from `package.json` `packageManager` (`corepack enable pnpm`)
- Android SDK tools (`adb`) for Android support
- Xcode (`simctl`/`devicectl`) for iOS support

Setup:

```bash
corepack enable pnpm
pnpm install
```

`package.json` `packageManager` is the single source of truth for the pnpm version. Corepack
activates that exact version locally, and `.github/actions/setup-node-pnpm` reads the same field
and fails the job when the installed `pnpm --version` disagrees — so the CI and local package
managers cannot drift apart silently, and the "Ignoring...pnpm" drift warning stays quiet locally.

Build all CLIs and Xcode projects:

```bash
pnpm build:all
```

Apple XCTest builds now share a common helper script. `pnpm build:xcuitest:ios` and
`pnpm build:xcuitest:tvos` keep their existing cleanup behavior, while
`pnpm build:xcuitest:macos` reuses the existing DerivedData by default for faster local
iteration. Set `AGENT_DEVICE_IOS_CLEAN_DERIVED=1` when you need a clean macOS runner rebuild.

Before pushing, run the aggregate gate:

```bash
pnpm check
```

That is `check:tooling && check:fallow && check:unit`, and it is the only command that covers
every non-device CI job. **`pnpm check:tooling` on its own is not the gate** — it stops before
`check:fallow`, so a dead export or a complexity finding your diff introduces still fails CI
after a clean `check:tooling` run. `pnpm test` likewise runs the unit projects only. What
`pnpm check` cannot cover is the device/smoke matrix, which needs real devices.

Run tests:

```bash
pnpm test
```

Targeted checks, while iterating:

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

Code quality (production exports): `pnpm check:production-exports` runs Fallow's native
production graph, which excludes test/story/dev files, and fails when a new export has no
production consumer. This includes the test-only-export bug class that shipped in #1199's first
revision, while also catching exports that are unreachable from every graph. It is intentionally
baseline-free: there is no grandfather file, so a new unused production export fails loudly. Fallow's
`ignoreExportsUsedInFile` option in the gate's inherited config keeps exports with a real
same-file consumer out of this report without weakening the general Fallow audit.

Fix a finding by wiring the export into production or removing the unnecessary export/code. For
an intentional test seam or other non-production consumer, add a JSDoc `@internal` tag with a short
justification beside the declaration. An inline
`// fallow-ignore-next-line unused-export` is not suitable here: the general test-inclusive graph
sees the test consumer and correctly reports that suppression as stale. Production usage reached
only through dynamic property access remains invisible to a static import graph, so register those
exports in `.fallowrc.json` `ignoreExports` instead (as with the daemon route handlers loaded
through `typeof import()`).

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

### Conservative Code Comments

When code deliberately chooses a slower or more conservative path, leave a short inline comment at
the decision site. The comment should name:

1. the failure or regression the conservative path prevents; and
2. the condition that should trigger a revisit.

Use a grep-able `CONSERVATIVE:` prefix when the choice is expected to outlive the current change.
This applies to defensive fallbacks, temporary guards, disabled fast paths, serialization, retries,
over-preservation, and teardown-to-be-safe behavior.

Examples:

```ts
// CONSERVATIVE: Keep the preflight for non-allowlisted runner commands because only the
// allowlist has proven healthy-mutation recovery. Revisit when lifecycle status coverage can
// distinguish every mutating command's terminal state.
```

```ts
// CONSERVATIVE: Preserve external runner artifacts because the checkout does not own their cache
// root. Revisit only if external artifacts get an ownership marker that makes cleanup safe.
```

## Dependency Updates

Renovate (`.github/renovate.json`) proposes dependency updates: weekly lockfile maintenance, one
grouped PR for devDependencies, one PR per runtime dependency, and digest bumps for GitHub Actions.
Security updates are enabled explicitly (`vulnerabilityAlerts` plus `osvVulnerabilityAlerts`) and
are the only updates exempt from the 7-day minimum release age.

Renovate PRs are gated exactly like human PRs: `automerge` is off everywhere, so every branch needs
a green CI run and a human review before merge. Review one the way you would review any dependency
change — read the release notes in the PR body, and check that the affected-check plan for the diff
(`pnpm check:affected --base origin/main --run`, which fails open to the full set for lockfile and
workflow changes) is green. A green Renovate PR is a merge candidate, not a merge: no rubber-stamp
automerge path exists, and none should be added without also deciding which gate is trusted to
replace the reviewer.

## Issue Labels

Issue labels describe workflow state, not who will do the work. See
`docs/agents/triage-labels.md` for the label meanings and state flow.

## Reporting issues

Please include:

- OS and Node version
- Xcode/Android SDK versions (if relevant)
- Exact command and output

Thanks for helping improve agent-device.
