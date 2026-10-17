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

Every release publishes from `.github/workflows/release.yml`, through npm trusted publishing: no
npm token or one-time password is involved, and every release version carries provenance. The one
exception is the empty `0.0.0` placeholder a maintainer publishes by hand to onboard a new package,
described below. A local `npm publish` from the repository root refuses to run.

The core and every public workspace package release together at one version. Private packages
stay unpublished. There are three channels:

- **Nightly** (`npm install -g agent-device@nightly`): once a day, at 01:23 UTC, the workflow
  checks `main`. It publishes `X.Y.Z-nightly.<YYYYMMDD>.<run>` under the `nightly` dist-tag when
  `main`'s HEAD has changed since the last nightly and its CI passed, waiting up to 20 minutes for
  CI that is still running. If that CI fails, is cancelled, or is still running after the wait, no
  nightly ships that day. A published nightly is tagged `nightly/v<nightly version>`. To publish one now, run **Release** on `main`.
- **Stable** (`latest`): a repository admin publishes a GitHub release with a new `vX.Y.Z` tag
  targeting `main`. Use the version `main` builds towards (its `X.Y.Z-dev`), or a later one, and
  write the notes or generate them in the release form. The tag starts a **Release** run. It waits
  up to 20 minutes for that commit's CI to pass, then publishes the packages without asking for
  approval, attaches the iOS runner and Android helper assets to the release, publishes the MCP
  Registry entry, and commits `main`'s next `-dev` version. Creating the tag is the approval. To
  stop a release, cancel the run before its publish job starts, then delete the release and its
  tag. Pushing the tag instead (`git push origin main:refs/tags/vX.Y.Z`) starts the same run, which
  then drafts the release itself.
- **Dry run**: a pull request that changes release tooling builds and verifies every package with a
  nightly version, and publishes nothing.

To retry a failed run, re-run its failed jobs, or run **Release** on the release tag. The
publisher skips package versions that are already on npm, so a partial publish completes on the
next attempt. To preview the packages locally, run
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

### One-time repository setup

npm trusts every run of `release.yml` that reaches the `npm-publish` environment, so GitHub
settings, not the workflow, decide who can publish. The tag ruleset approves a stable release, so
the plan job refuses to publish until the first two settings are in place. Apply them before
granting npm trust:

1. **Environment `npm-publish`** (Settings → Environments): deployment branches and tags limited to
   the branch `main` and the tag pattern `v*`. No reviewers and no secrets, so nightlies run
   unattended.
2. **Tag ruleset** (Settings → Rules → Rulesets → New tag ruleset): active, targeting
   `refs/tags/v*` with no exclusions, restricting creations, updates, and deletions, with only the
   Repository admin role allowed to bypass. Nightly tags live under `nightly/` and stay outside it.
3. **Actions** (Settings → Actions → General): workflow permissions set to read repository contents,
   and "Allow GitHub Actions to create and approve pull requests" turned off.
4. **Releases** (Settings → General): leave release immutability off, because the run attaches its
   assets after the release is published.

Confirm the result, then grant npm trust to each public package and, once a nightly has published,
refuse token-based publishing:

```bash
gh api repos/callstack/agent-device/environments/npm-publish/deployment-branch-policies \
  --jq '.branch_policies[] | "\(.type) \(.name)"'   # branch main, tag v*
gh api repos/callstack/agent-device/rulesets --jq '.[] | select(.target == "tag") | .name'
npm trust github <package> --file release.yml --repository callstack/agent-device \
  --environment npm-publish --allow-publish --yes
npm access set mfa=publish <package>
```

Anyone who can push to `main` can still change what the next nightly publishes; `main` does not
require pull requests.

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

Before pushing, commit the change and validate that exact commit. The repository derives the
required gates from the diff:

```bash
pnpm check:affected --run --head "$(git rev-parse HEAD)"
```

Only a passed receipt with `exactCommit: true` proves validation at that commit. Without `--head`,
the run also includes staged, unstaged, and untracked files; treat that result as local feedback.
Unknown, workflow, lockfile, and selector-owning changes fail open to the full local set. For broad
refactors or when explicitly requested, run `pnpm check`: formatting, lint, typechecking, layering,
dependency-graph parity, production exports, MCP metadata, docs prose and links, the build, bundle
ownership, the package check, Fallow, unit tests, and local smoke tests. Both commands share one host
lock and need macOS or Linux; on Windows, use the affected plan and direct focused checks. GitHub CI
stays authoritative for coverage, provider integration, history-backed compatibility, specialized
toolchains, and live device lanes.

Useful direct entry points:

- `pnpm test` or `pnpm test:unit` — root unit projects
- `pnpm test:coverage` — coverage plus coverage-only projects
- `pnpm test:integration` — Node and provider-backed integration suites
- `pnpm perf --platform ios` or `pnpm perf --platform android` — device performance harness
- `pnpm check:fallow --base origin/main` — changed-code quality gate
- `pnpm check:coverage-crap --base origin/main` — CRAP from measured coverage for the functions a
  change touches; it fails when one scores 30 or more, so run `pnpm test:coverage` first. It also
  fails when `coverage/` was not written by that command on this commit. `--all` reports every
  function and never fails: that is `main`'s backlog. Both list the per-function CRAP ceilings from
  `.fallowrc.json` they honoured. `check:fallow` leaves CRAP off without coverage.
- `pnpm fallow:all` — full-tree audit, including grandfathered baseline findings
- `pnpm fallow:baseline` — intentionally regenerate the reviewed Fallow health baseline

See [`docs/agents/testing.md`](docs/agents/testing.md) for check selection and blocked validation; see
[`test authoring`](docs/agents/test-authoring.md) for shared test utilities and test-speed rules. See [gate maintenance](docs/agents/gates.md) for mutation and fuzz harnesses. For real devices, follow
[`docs/agents/device-verification.md`](docs/agents/device-verification.md); a fixture-backed test does
not prove that a native path was active.

### Reading a coverage-CRAP failure

One rule decides whether `check:coverage-crap --base <ref>` can answer: `coverage/` must have been
written by a full `pnpm test:coverage` in this checkout, and this checkout must still be the tree that run
read. The command writes `coverage/coverage-run-stamp.json` beside its reports and the gate re-reads it, so
anything that moves afterwards — a commit, or an edit to any file the run could have loaded that git tracks
or would track (source, tests, setup files, or the config that declares the scope) — prints
`no trustworthy verdict` and names which of those it is. That is the guarantee's limit: an ignored path is
not hashed, so an edit confined to one leaves the stamp standing. A narrowed pass is refused the same way —
by file filter, project filter, name pattern, shard, or tag filter — because it still reports every file the
config instruments, mostly with no counters, so the functions its missing tests would have covered arrive as
untested. A focused `test.only` is caught earlier, by `--allowOnly=false` on the lane itself, which fails the
pass before it writes any reports. Re-run `pnpm test:coverage` and re-check; that is the whole fix, and in CI
the two steps are one job so the refusal cannot fire.

What the verdict then says is a separate question. It scores the functions whose lines your diff adds,
so a stale map can no longer hide a score you owe, and what counts as debt is editing a function that
already scores 30 or more — the score does not have to be new. Two gaps still print `no trustworthy
verdict` after a matching stamp: a touched file the run recorded with counts no execution can produce,
and a touched file the config instruments that the map does not record at all. Both mean re-run
coverage. Adding lines is what charges a function; deleting is not, and removing a whole function takes
its score with it. The two still interact: a charged function is scored as it stands after your
deletions, and dropping lines that used to be covered can raise that number. A deletion-only edit is
therefore never charged, and neither is a mixed one so long as no added line lands inside that function
— the deletion stays out of the PR and whatever the score rose to waits in the `--all` backlog. Moving
a file without editing its lines touches none of its functions. Unlike the changed-line gate, this one
has no `coverage-waiver` label: the only way past a score is to test or simplify the function, or to
raise the ceiling for that one function in `.fallowrc.json`'s `health.thresholdOverrides`.

What is listed rather than blocked, so a green run does not mean it was checked: a touched function
with no counters in a file the map does record — an ignore comment discarded its lines, or it runs where
the inspector never sees it — and a touched file out of scope because the config excludes it or its
source carries a whole-file ignore comment. No re-run scores any of those, and blocking on them would
refuse every tooling PR. A file the config instruments that the map omits entirely stays a gap:
out-of-process code looks the same from here as code the run never loaded, so the file has to declare
itself out of scope — the config's `exclude`, or a whole-file ignore comment. Estimates are compared
against 30 too, so a below-bar guess about new code is not reported at all; the stamp is what stops that
guess from standing in for a measurement of code you changed.

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
pnpm check:affected --verbose
pnpm check:affected --run --head "$(git rev-parse HEAD)"
```

## Issues

Issue labels describe workflow state, not ownership. See
[`docs/agents/triage-labels.md`](docs/agents/triage-labels.md).

When reporting a problem, include the OS and Node version, relevant Xcode or Android SDK versions,
and the exact command and output.
