# #2617 experiment: typed ADB transport addressing beside the device-command payload

Design trace and disposable prototype from 2026-09-15, base `origin/main` `2cafab3ad0`, prototype
branch `spike/2617-typed-adb-addressing` (`72a1467a93`, `b79e96ccd5`, `74c72809a6`, `5dc8ced575`).
The prototype is measurement scaffolding: it is not a production migration and must not be merged.

Blocking dependency re-audit first: **#2611 is still open** (`headRefOid` `a3a0ea216`, `mergedAt`
null), and `packages/kernel/src/device-shell.ts` does not exist on `main`. Every device-shell relay
claim below therefore describes a branch shape, not merged transport reality; the relay sites were
read from `git fetch origin pull/2611/head:pr-2611-audit` (6 production `relayDeviceShellArgv` sites,
including the two generic-host copies). #2026 owns shell quoting; nothing here changes quoting or the
kernel-owned shell fragment representation.

## Accepted addressing grammar

Read from `adb help` on the measurement host (adb `1.0.41`, version `35.0.2-12147458`), not from the
two fields the current code models:

| Grammar form | Modelled on `main` | Modelled in the prototype |
| --- | --- | --- |
| `-s SERIAL` | scanned and stripped (`2cafab3ad0:packages/platform-android/src/adb-provider-scope.ts:252`, `:277`) | `target.selector = { kind: 'serial', serial }` |
| `-P PORT` | only under a lease, by scan-and-replace (`2cafab3ad0:src/platform-runtime-android-adb-host.ts:164`) | `target.server = { kind: 'port', port }`, emitted by one serializer |
| `-P 9999` with no lease | left in argv, no env change | `rawArgv` kept verbatim, no env change (see Findings 6) |
| `-P <not-a-number>` | silently dropped and replaced under a lease | `hostGlobals` → refused under a lease (residual exception) |
| `-H HOST`, `-L SOCKET`, `-a`, `-d`, `-e` | skipped while looking for `-s` (`:252`), refused only under a lease | `target.hostGlobals`, carried verbatim, refused under a lease |
| `-t ID` | aborts the serial scan entirely, so a `-t` selection is neither honoured nor refused | `target.hostGlobals`, refused under a lease |
| second `-s` (adb lets the later one win; verified with `adb -s A -s B get-state`) | both survive; position decides | first becomes `selector`, second stays in `hostGlobals` and keeps its winning position |
| `wait-for[-TRANSPORT]-STATE` | prefix-skipped by `assertManagedAdbCommand` when picking the command | `target.waitFor`, tail becomes `command` |

`serial` and `serverPort` are two of the selections adb actually offers. Typing only those two keeps
today's blind spot: on an ambient route a `-H foreign.example` is only ever *skipped*, and a `-t 42`
selection stops the scan, so no router can see either one.

## Routes, representation, and payload identity

Measured with throwaway probes against the real root host binding, with
`payload = ['shell','input','tap','13','42']`. "Payload identity" asks whether `invocation.command` at
the host port is the caller's array; the emitted argv is always a fresh array on every route, on
`main` and here alike. No committed test asserts reference identity today — that assertion belongs in
the production cut, not in a spike.

| Route | Entry | Addressing on `main` | Addressing in the prototype | Payload identity |
| --- | --- | --- | --- | --- |
| Device exec, no provider in scope | `runAndroidAdb` → `resolveAndroidAdbExecutor` → `createDeviceAdbExecutor` (`packages/platform-android/src/adb-provider-scope.ts:124`) | `-s` stitched by `execSerialAdb`, then `-P`/`-s` re-scanned by `withServerPort` (`2cafab3ad0:src/platform-runtime-android-adb-host.ts:86`, `:164`) | one `target`, one serializer | held (`command === payload`) |
| Same route, caller smuggled `-s` | same | emits `-s <device> -s <other>`; adb obeys the later one | `rawArgv` `['-s', device, …args]`, so the emitted argv is identical | held |
| Managed device (lease port) | same, `serverPort` set | argv rebuilt twice (`adbInvocation` + `withServerPort`) | `applyManagedAndroidAdbServer` rewrites addressing only | held |
| Managed device, smuggled matching `-s` | same | slice + rebuild | re-sliced by the parser | **lost** (addressing arrived inside the payload) |
| Provider forwarding | `runCmd('adb', …)` inside `withAndroidAdbProvider`, arm at `2cafab3ad0:packages/platform-android/src/adb-provider-scope.ts:175` | serial read, then `stripAdbSerialArgs` rebuild | provider receives a copy of `invocation.command` (`adb-provider-scope.ts:214`) | elementwise equal, not the caller's array |
| Managed host-level adb | host transport arm, `2cafab3ad0:…:204` | `execHostAdb(['-s', scope.serial, …args])` | serial adopted into `target` by `withScopedSerialTarget` | held at the host port |
| Managed server-port precedence | request `-P 9999` + lease `15038` | scan-and-replace, refusal on any other leading option | `applyManagedAndroidAdbServer` | argv `['-P','15038','devices']`, asserted at `src/platform-runtime-android-adb-host.test.ts:144`; the device-scoped form with `-s` is asserted at `:131` |
| Background spawn | `spawnSerialAdb` (`2cafab3ad0:src/platform-runtime-android-adb-host.ts:95`) | `runCmdBackground` passes `options.detached` through (`packages/host-kit/src/internal/exec.ts:391`) and `main` never sets it, so background adb is not detached | `spawnAdb`, still not detached | unchanged; see Findings 1 |
| Limrun provider | `2cafab3ad0:packages/provider-limrun/src/android.ts:193` | `['-s', serial, …args]` prefix | structural `LimrunAdbInvocation`, tunnel serial as addressing | provider-facing executor stays argv-shaped for `@limrun/api` |
| Generic host command port | `host.commands.run({ executable: 'adb', args: ['-s', …] })`, copied again at `src/platform-runtime-host.ts:21` and `src/platform-runtime-operation-host.ts:60` | flat argv | untouched by this spike | not measurable: still flat |

## Proposed API

`packages/platform-android/src/adb-addressing.ts` (241 lines) owns grammar and managed policy:

```ts
type AndroidAdbSelector = { kind: 'unspecified' } | { kind: 'serial'; serial: string };
type AndroidAdbServer = { kind: 'ambient' } | { kind: 'port'; port: number };
type AndroidAdbTarget = Readonly<{
  selector: AndroidAdbSelector;
  server: AndroidAdbServer;
  waitFor?: 'device' | 'usb-device' | 'local-device' | 'any-device';
  hostGlobals?: readonly string[];
}>;
type AndroidAdbInvocation = Readonly<{
  target: AndroidAdbTarget;
  command: readonly string[];
  rawArgv?: readonly string[];
}>;
```

Two directions only: `parseAndroidAdbArgv` (the single place that re-slices a payload, and only when
addressing was present — otherwise `command` is the caller's array) and
`serializeAndroidAdbInvocation` (the single emitter; returns `rawArgv` verbatim when nothing was
rewritten). Managed rules: `applyManagedAndroidAdbServer`, `requireManagedAndroidAdbSerial`,
`requireManagedAndroidAdbCommand`, `androidManagedAdbEnvironment`, and
`androidAdbOwnedServerPort`, which separates a lease-owned port from a `-P` the caller typed. The host
port collapses `execSerialAdb`/`spawnSerialAdb`/`execHostAdb` into `execAdb`/`spawnAdb`, so
`src/platform-runtime-android-adb-host.ts` nets **-53 lines** (`+33 -86`). The in-package test host
still holds its own copy of the lowering, but now calls the shared server-rewrite and serializer
instead of rebuilding `-P`/`-s` by hand; it still does not model the env carrier.

## Numbers

| Measure | `main` | prototype |
| --- | --- | --- |
| Independently authored addressing/refusal owners (11 named) | serial scan + strip, scope-identity refusal, port-precedence refusal, two host-level `-s` stitches, `withServerPort` scan + refusal, `assertManagedAdbCommand`, managed env lowering, detach-by-method, Limrun device prefix, Limrun host prefix, eight route-level `-s` stitches | 5 answer to `adb-addressing.ts` (scan + strip, the two stitches, `withServerPort` + refusal, `assertManagedAdbCommand`, env lowering); the two Limrun ones moved to a structural duplicate inside `provider-limrun`, which cut-set step 1 says to remove; detach became an explicit option; scope-identity, port precedence and the eight route-level stitches stayed put |
| Literal `'-s'` producers/consumers in production (excluding tests, fixtures and non-adb uses) | 17 | 13: 3 in the owning module, 1 ambient `rawArgv` escape, 1 Limrun serializer, 8 untouched route sites |
| New parsers/serializers | — | 1 parser, 1 serializer, 1 env builder, 1 owned-port predicate |
| New bridges | — | 2, both in `provider-limrun`: structural `LimrunAdbInvocation` (`runtime-dependencies.ts:103`) and `limrunAdbArgv` (`android.ts:227`) to keep failure text identical |
| Extra payload copies | — | +1 at the provider hand-off (`adb-provider-scope.ts:214`, `readonly` → mutable); the two generic-host `[...request.args]` copies are untouched |
| Production LOC | — | `+481 -199` (net **+282**); outside the 241-line module, net **+41** |
| Test LOC | — | `+255 -108`, all of it migrated assertions on the same argv expectations, no new synthetic executor |
| `readonly` payload cost | n/a | throwaway mutation of `AndroidAdbExecutor`'s payload to `readonly string[]` (not committed): 96 type errors in 24 files, **1 in production source** (`adb-provider-scope.ts:57`, one signature widening) |

Gate status on the prototype: 118 files / 846 tests green for
`pnpm test:unit packages/platform-android packages/provider-limrun src/platform-runtime-android-adb-host.test.ts src/managed-device-reachability.test.ts`,
and 12 files / 59 tests green for the released-surface, SDK, provider-scope, dialog-readiness,
readiness-spawn and routing-parity lanes, i.e. `pnpm test:unit src/__tests__/android-adb-public.test.ts
src/sdk/android-adb.test.ts src/__tests__/limrun-runtime.test.ts
src/daemon/__tests__/request-handler-chain-provider-scope.test.ts
src/daemon/__tests__/android-owner-seam.test.ts src/daemon/__tests__/android-dialog-readiness.test.ts
src/daemon/interaction/internal/__tests__/interaction-touch-android-readiness-spawns.test.ts
src/daemon/interaction/internal/__tests__/interaction-type-android-readiness.test.ts
src/__tests__/platform-runtime-android-application-tools.test.ts
src/__tests__/platform-runtime-runtime-hints.test.ts src/__tests__/package-exports.test.ts
src/daemon/__tests__/providers-plugin-routing-parity.test.ts`. Root `npx tsc -p tsconfig.json` reports 0 errors; `pnpm lint` and
`pnpm check:layering` pass.

## Findings a migration must carry

1. **The detach policy rode on which host method you called.** `execSerialAdb` detached on non-Windows
   (`2cafab3ad0:src/platform-runtime-android-adb-host.ts:85`, `:91`); `spawnSerialAdb` (`:95`) and
   `execHostAdb` (`:105`) did not, and `runCmdBackground` forwards `options.detached`
   (`packages/host-kit/src/internal/exec.ts:391`) rather than forcing it. Collapsing to one `execAdb`
   and keying the flag on "target has a serial" silently detached managed host-level calls, which
   changes timeout and `killProcessTree` behaviour. The spike carries the decision as an additive
   `AndroidAdbExecutorOptions.detached` set only by the device-scoped executor.
2. **A hand-written typed guard disagreed with the shared rule on first contact** (`72a1467a93`). Two
   separate escapes: the device route rebuilt the target from the serial alone, so parsed
   `hostGlobals` never reached any refusal (`-H`, `-L`, `-t`, `-d`, `-e`, `-P9999` all ran), and
   `requireManagedAndroidAdbCommand` tested `command[0]` where
   `assertManagedAdbCommand` picks the first token that does not start with `wait-for-`
   (`2cafab3ad0:src/platform-runtime-android-adb-host.ts:189`), so `wait-for-device kill-server`,
   `wait-for-device disconnect` and `wait-for-any-device pair …` ran too. The existing 21-selector loop
   in `src/platform-runtime-android-adb-host.test.ts:100` caught all nine; it is the oracle for this
   grammar and belongs in a golden table under `contracts/fixtures/` if the rules go cross-language.
3. **The port carrier differed between the real host and the in-package test host.** The real lowering
   strips `serverPort` and emits `-P` plus `ANDROID_ADB_SERVER_PORT`/`ANDROID_ADB_SERVER_ADDRESS`; the
   unit host passed `serverPort` through untouched, so
   `packages/platform-android/src/__tests__/adb-executor.test.ts` asserted the stub's carrier. Sharing
   the rewrite moved that assertion to argv, where it now tests the production contract. Deleting the
   test-host copy of the lowering, env carrier included, is a cut-set item, not a free win.
4. **Flat ingress cannot be fixed downstream.** Nine sites hand `-s` to a flat argv:
   `logs/runtime.ts:71`, `:105`, `network/runtime.ts:123`, `:156`, `readiness/runtime.ts:119`,
   `shutdown/runtime.ts:39`, `inventory.ts:246` (all through `host.commands.run`), plus
   `src/platform-runtime-app-log-process.ts:187` (through `runCmdBackground`). There the payload is
   re-sliced by definition, and `[...request.args]` copies it again at `src/platform-runtime-host.ts:21`
   and `src/platform-runtime-operation-host.ts:60`. Identity survives only where the producer already
   separates addressing.
5. **`@limrun/api` pins argv at the provider edge.** `LimrunAdbExecutor(args)` is handed to that
   external package, so the provider-facing executor has to stay argv-shaped; only the host port
   (`LimrunRuntimeDependencies.host.runAdb`) can be typed. `provider-limrun` declares no
   `platform-android` dependency, so the spike duplicated the invocation structurally and mirrored argv
   for failure text — the two bridges a shared addressing home removes.
6. **Two ambient divergences surfaced in adversarial review and were closed** (`5dc8ced575`). Treating
   any `target.server` port as lease-owned meant a caller-typed `-P 9999` on a host-level call started
   lowering `ANDROID_ADB_SERVER_*` and applying managed command refusal, which `main` never did; and a
   non-numeric `-P` became a refusal where `main` dropped it silently under a lease. The fix keeps
   caller-typed addressing in `rawArgv` and reads the lease port through `androidAdbOwnedServerPort`.
   Verified: `['-P','9999','devices']` now emits `["-P","9999","devices"]` with no env change and an
   inherited `ADB_SERVER_SOCKET`, and `['-P','9999','kill-server']` still runs. The non-numeric case
   stays a deliberate residual exception: refusing is safer than silently rewriting, but it is a
   behavior change.
7. **`detached` already existed on `AndroidAdbSpawnOptions`**, so the finding is not that the flag was
   invented here; it is that the exec-side policy had no carrier and lived in the method name.
8. **Released surface is narrower than it looks.** `agent-device/android-adb` publishes
   `AndroidAdbExecutor`, `AndroidAdbExecutorOptions`, `AndroidAdbProvider`, `AndroidPortReverseEndpoint`
   and nine `*WithAdb` helpers (`src/sdk/android-adb.ts:2`-`:34`), so the executor payload must stay
   `(args: string[])` and `detached` must stay additive. `AndroidAdbHost` and `AndroidAdbInvocation`
   live on private workspace packages (`@agent-device/platform-android`,
   `@agent-device/provider-limrun`) and appear in no published export list, so they carry no external
   compatibility obligation.

## Recommendation: continue, with a smaller cut than the prototype

Continue. Five independently authored addressing decisions now answer to one module, a sixth and
seventh are ready to follow once addressing has a shared home, the change costs +41 production lines
outside that module, and one signature widening makes the payload read-only across the platform.
Enforcement did not weaken: the four refusal throw sites on `main` became two owners — the addressing
module for grammar and lease rules, provider scope for scope-identity and port precedence, which answer
scope questions rather than grammar. Stop criteria are not met: no lifecycle behaviour had to change
once `detached` was an option, and the two new bridges are both explained by one missing home. Cut set:

1. Decide the addressing home first: a tiny `@agent-device/adb-addressing` package, or an explicit
   `provider-limrun` → `platform-android` edge. Do not ship the structural duplicate.
2. Land the addressing module and the host port collapse (`execAdb`/`spawnAdb`) with the lowering and
   the env carrier exported from the platform package, so the real host and the test host cannot
   diverge, and with `detached` as an explicit option.
3. Move the managed refusal set and the grammar into a golden table under `contracts/fixtures/`,
   keeping the 21-selector loop as the parity oracle.
4. Re-route the nine generic host command port adb calls onto the android host port instead of
   `commands.run`; this is where the `-s` stitches and the argv copies actually disappear.
5. Type the provider host port (`host.runAdb`) and keep `LimrunAdbExecutor` argv-shaped.
6. Add a committed payload-identity assertion at the host port; the spike measured identity with
   throwaway probes only.
7. Re-audit after #2611 lands: its six `relayDeviceShellArgv` sites are the provenance relays that
   steps 2 and 4 should make unnecessary.

Validation lanes for the production proposal: `pnpm test:unit packages/platform-android
packages/provider-limrun`, `pnpm test:unit src/platform-runtime-android-adb-host.test.ts
src/managed-device-reachability.test.ts src/sdk/limrun-runtime-dependencies.test.ts
src/__tests__/android-adb-public.test.ts`, `pnpm check:affected --run`, plus a device-backed pass
through `test/integration/provider-scenarios/android-lifecycle.test.ts` for `exec-out` binary results
and background `logcat` spawn, which no unit lane covers.

## Unresolved evidence and pitfalls

- Device-backed verification was not run: this is a docs-only deliverable, and the spike claims only
  argv, refusal and identity parity against existing lanes.
- Ambient routes keep argv authority: `rawArgv` wins at serialization, so on those routes `target` is
  advisory and a later `-s` still wins. `rawArgv` is a heuristic, not the design: a production shape
  needs explicit provenance for "caller requested" versus "lease owns" instead of inferring it from
  which fields are populated. That decision is unresolved and deliberately out of scope here.
- `-P <not-a-number>` under a lease now refuses where `main` silently replaced it (Findings 6).
- `pnpm typecheck` on `2cafab3ad0` fails in `packages/platform-android/src/__tests__/snapshot-helper-install.test.ts:29`
  (`installArgs` was dropped from `AndroidSnapshotHelperManifest` by `f07a4eca31` (#2618) while the
  fixture still sets it, added by `2cafab3ad0` (#2619)). Because `typecheck` chains with `&&`, that one
  package error means `tsc -p tsconfig.json` and the `examples/sdk` project never run. All root
  typecheck claims here come from running `npx tsc -p tsconfig.json` directly. Fix the fixture
  separately.
- `src/sdk/limrun-runtime-dependencies.test.ts > Limrun construction defers operation and
  opposite-platform helper modules` is timing-dependent on this host: seen failing against its budget on
  `2cafab3ad0` and passing at 4.3 s at HEAD. Treat it as flaky, not as evidence. The eager-closure claim
  therefore rests on import inspection: `adb-addressing.ts` imports only `@agent-device/kernel/errors`,
  and `src/__tests__/package-exports.test.ts` stays green.
- `pnpm check:production-exports` exits 0 because `fallow-production-exports.json` sets
  `unused-exports` to warn, while reporting 68 unused exports across 40 files. None of those files is in
  this diff and none of the exports this spike adds is flagged, so the count is unchanged — but do not
  read a green exit here as an unused-export clean bill.
- `git stash` is unusable for isolation in parallel worktrees: the stash ref lives in the shared common
  git directory, so a `stash pop` in one worktree can apply another agent's stash and drop the entry.
  Commit on a spike branch and use `git checkout --` to go back.
