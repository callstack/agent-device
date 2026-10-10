# Contributing

Thanks for helping improve agent-device. This guide is the shortest path from a fresh checkout to a
reviewable change. Detailed testing and device procedures live in the linked focused guides.

## Set up the repository

Requirements:

- Node.js 22.13 or newer — the pinned pnpm requires it. The published package keeps a lower
  `engines.node` floor of 22.12, which CI verifies separately on the installed tarball.
- pnpm at the version pinned in `package.json`
- Android SDK tools (`adb`) for Android work
- Xcode (`simctl`/`devicectl`) for Apple-platform work

```bash
pnpm install
pnpm build
```

`package.json`'s `packageManager` field is the source of truth for pnpm, and CI rejects a different
version. Node distributions that include Corepack can activate it with `corepack enable pnpm`.
Newer Node distributions may not bundle Corepack; in that case, install the pinned pnpm version
using your Node version manager or the [pnpm installation guide](https://pnpm.io/installation), then
confirm it with `pnpm --version` before installing dependencies.

The root install does not install the much larger Expo test-app dependency graph. If your change
touches `examples/test-app`, install it separately:

```bash
pnpm test-app:install
pnpm test-app:typecheck
```

## Build the surface you changed

`pnpm build` compiles the TypeScript CLI and library. If a running development daemon must pick up
that build, use `pnpm rebuild:cli`; it builds and then stops the worktree-scoped daemon.

`pnpm clean:daemon` retains state when it cannot confirm the recorded daemon exited. Restore
process inspection or stop the verified owner before retrying. Its `--prune-dev` option considers
dev state directories whose newest observed modification is at least 14 days old. It retires
confirmed abandoned registrations and keeps session artifacts and state directories for inspection.

Build only the Apple runner target you changed:

```bash
pnpm build:xcuitest:ios
pnpm build:xcuitest:macos
pnpm build:xcuitest:tvos
pnpm build:xcuitest:visionos
```

Append `:clean` to any platform build when DerivedData may be stale, for example
`pnpm build:xcuitest:macos:clean`. `pnpm build:xcuitest` remains the shared iOS-and-macOS gate for
changes that affect both runners; it is not an all-platform build.

Android and macOS helper builds remain separate because they require their native toolchains:

```bash
pnpm build:android
pnpm build:macos-helper
```

There is intentionally no catch-all development build. Native toolchains are expensive and
independent, so agents and contributors should run the command for the surface they changed.
Use `pnpm build:macos-helper:clean` if a Swift cache was created in another worktree.

## Prepare the npm package

Package-manager pack commands run `prepack`, which first checks synchronized MCP
metadata and then runs `pnpm package:npm`. This is the one completeness-oriented aggregate: it
builds the TypeScript distribution and all four Apple runner targets (into a scratch directory under
`.tmp/` that it removes afterwards, not into `~/.agent-device`), clean-builds the macOS helper,
packages the Apple runner source, and rebuilds both Android helper APKs. Any failed build stops
packaging. It deliberately does not stop the worktree's development daemon; use `pnpm rebuild:cli`
when a running daemon needs to pick up a new TypeScript build.

That Android leg needs `AGENT_DEVICE_ANDROID_BUILD_TOOLS` naming the build-tools version to compile
with. An unpinned build takes the newest version installed on the machine, which CI refuses to do,
so name the version the CI lanes install and the published helper matches the CI-built one.

`pnpm package:npm` is a release guard, not a routine development command. Use the specific commands
above while iterating.

### Release through the Release workflow

Every npm publish runs in `.github/workflows/release.yml`, through npm trusted publishing: no npm
token or one-time password is involved, and every version carries provenance. A local
`npm publish` from the repository root refuses to run.

The core and every public workspace package release together at one version. Private packages
stay unpublished. There are three channels:

- **Nightly** (`npm install -g agent-device@nightly`): every few hours the workflow checks `main`.
  It publishes `X.Y.Z-nightly.<YYYYMMDD>.<run>` under the `nightly` dist-tag when `main`'s HEAD has
  changed since the last nightly, its CI passed, and no nightly shipped that UTC day. It then tags
  the commit `v<nightly version>`. To publish one now, run **Release** with `channel: nightly`.
- **Stable** (`latest`): run **Release** with `channel: stable`. It promotes the latest nightly's
  commit, by default as the `X.Y.Z` that nightly previewed. Set `version` to release it under
  another number. The run tags that commit `vX.Y.Z` and starts the stable run on the tag. The stable
  run waits for approval in the `release` environment, then publishes the packages, drafts the GitHub
  release with generated notes, attaches the iOS runner and Android helper assets, publishes the
  release and the MCP Registry entry, and commits `main`'s next `-dev` version. Pushing a `vX.Y.Z`
  tag yourself starts the same stable run for that commit.
- **Dry run**: a pull request that changes release tooling builds and verifies every package with a
  nightly version, and publishes nothing.

To retry a failed run, re-run its failed jobs. The publisher skips package versions that are already
on npm, so a partial publish completes on the next attempt. To preview the packages locally, run
`pnpm release:prepare`. It builds, verifies, and packs every public package into `.tmp/release`.

A public package owns its `files`, published `exports`, license, repository metadata, README,
and `prepack` build (including any prerequisites). Use `publishConfig.exports` for source-only
workspace test exports; pnpm applies the overrides when packing. Keep plugin SDK imports and
bundled workspace helpers in `devDependencies`. Plugins must not depend on the core at runtime
or through a peer dependency. Their factories receive the host from `agent-device`.

When adding a public package, initialize its version from the root `package.json`; the release
workflow stamps the release version into every public package. An optional plugin must have no
production import from the core build or production dependency in the root manifest. Run its
packed-install smoke before releasing. npm can only trust a package that exists, so a maintainer
publishes an empty `0.0.0` placeholder once and grants the trust before the next nightly:

```bash
cd "$(mktemp -d)"
echo '{"name":"@agent-device/<name>","version":"0.0.0","license":"MIT"}' > package.json
npm publish --access public --tag reserved
npm trust github @agent-device/<name> --file release.yml --repository callstack/agent-device \
  --environment npm-publish --allow-publish --yes
npm access set mfa=publish @agent-device/<name>
```

### The version on main never equals a published version

`main` carries `X.Y.Z-dev`, naming the release it is building towards. Nightlies preview it as
`X.Y.Z-nightly.*`, and only a stable release publishes `X.Y.Z`. After a stable release, the workflow
moves `main` to the next patch's `-dev` version, unless `main` already builds towards a later
release. To plan a minor or major release, commit the new `-dev` version to `main` (for example
`0.22.0-dev`); nightlies then preview it. The invariant protects MCP Registry scanners, which diff
the repository's tool surface per version string: a released number left on `main` while `main`
keeps changing is indistinguishable from a republished ("rug-pull") version.

### Released-surface baselines roll forward on publish

Compatibility gates baseline against the last **released tag**, not against `main`, so publishing is
what advances them — there is no separate baseline-refresh step and no regenerate command. Tagging a
release makes that commit's `test/wire-compat/ledger.json` the new baseline for
`pnpm check:daemon-wire-compat`, and its `.ad` corpus tags the new ceiling for
`pnpm check:replay-compat`. The practical consequence for a normal PR: wire churn *within* an
unreleased branch is free, and only the net change since the last publish has to carry a
`DAEMON_RPC_PROTOCOL_VERSION` bump or a `compatibleChanges` acknowledgment. After a release that
bumped the protocol version, the acknowledgments accumulated against the previous one no longer
match any current digest and are dropped — git history keeps the audit trail.

## Validate a change

Use the smallest trustworthy loop while editing:

```bash
pnpm check:quick             # lint + TypeScript
pnpm test:maestro-compat     # example of a focused family suite
pnpm exec vitest run path/to/file.test.ts
```

Before pushing a normal code change, let the repository derive the required gates:

```bash
pnpm check:affected --run
```

The selector combines the committed diff with staged, unstaged, and untracked files. Unknown,
workflow, lockfile, and selector-owning changes fail open to the full local set. It reports
device/toolchain checks that remain GitHub-authoritative instead of trying to run them implicitly.

For broad refactors or when explicitly requested, run the deterministic core aggregate:

```bash
pnpm check
```

`pnpm check` covers formatting, lint, typechecking, layering, dependency-graph parity, production
exports, MCP metadata, the distributable build, bundle ownership, Fallow, unit tests, and local smoke
tests. It is intentionally not a simulation of every CI job: coverage, provider integration,
history-backed compatibility, specialized toolchains, and live device/browser lanes remain separate.
GitHub CI is authoritative.

Useful direct entry points:

- `pnpm test` or `pnpm test:unit` — root unit projects
- `pnpm test:coverage` — coverage plus coverage-only projects
- `pnpm test:integration` — Node and provider-backed integration suites
- `pnpm perf --platform ios` or `pnpm perf --platform android` — device performance harness
- `pnpm check:fallow --base origin/main` — changed-code quality gate
- `pnpm fallow:all` — full-tree audit, including grandfathered baseline findings
- `pnpm fallow:baseline` — intentionally regenerate both reviewed Fallow baselines

See [`docs/agents/testing.md`](docs/agents/testing.md) for gate ownership, shared test utilities,
mutation/fuzz lanes, contention policy, and test-speed rules. For real devices, follow
[`docs/agents/device-verification.md`](docs/agents/device-verification.md); a fixture-backed test does
not prove that a native path was active.

## Test app and Maestro compatibility

The Expo fixture app owns its setup, simulator/device, Metro, replay, and Maestro instructions in
[`examples/test-app/README.md`](examples/test-app/README.md).

The stable compatibility entry points are:

```bash
pnpm test:maestro-compat
pnpm maestro:conformance
pnpm test-app:maestro:ios
pnpm test-app:maestro:android
```

The first two are deterministic and device-free. The test-app suites need the app, Metro when
applicable, and a real simulator or emulator.

## Contribution guidelines

- Keep dependencies minimal and prefer built-in Node APIs.
- Preserve the CLI's compact, agent-friendly JSON output.
- Open and close sessions explicitly in tests and manual verification.
- Add or adjust integration coverage when introducing a command or changing a wire response.
- Run the focused gate that owns the behavior; do not replace missing coverage with a broad,
  assertion-free test.

### Conservative code comments

When code deliberately chooses a slower or more conservative path, leave a short comment at the
decision site naming the prevented failure and the condition for revisiting the choice. Use the
grep-able `CONSERVATIVE:` prefix when the decision is expected to outlive the current change.

```ts
// CONSERVATIVE: Preserve external runner artifacts because the checkout does not own their cache
// root. Revisit only if external artifacts get an ownership marker that makes cleanup safe.
```

## Dependency updates

Renovate proposes weekly lockfile maintenance, grouped development-dependency updates, individual
runtime-dependency updates, and GitHub Action digest bumps. Automerge is disabled: dependency PRs
need green CI and human review.

Read the release notes, inspect the affected-check plan, and treat a green update as a merge
candidate rather than an automatic merge:

```bash
pnpm check:affected --run
```

## Issues

Issue labels describe workflow state, not ownership. See
[`docs/agents/triage-labels.md`](docs/agents/triage-labels.md).

When reporting a problem, include the OS and Node version, relevant Xcode or Android SDK versions,
and the exact command and output.
