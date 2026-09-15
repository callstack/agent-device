# #2617 experiment: typed ADB transport addressing beside the device-command payload

Design trace and disposable prototype from 2026-09-15, base `origin/main` `2cafab3ad0`, prototype
branch `spike/2617-typed-adb-addressing` (`72a1467a93`, `b79e96ccd5`, `74c72809a6`). The prototype
is measurement scaffolding: it is not a production migration and must not be merged.

Blocking dependency re-audit first: **#2611 is still open** (`headRefOid` `a3a0ea216`,
`mergedAt` null), and `packages/kernel/src/device-shell.ts` does not exist on `main`. Every
device-shell relay claim below therefore describes a branch shape, not merged transport reality, and
the prototype was traced against `main` with the #2611 relay sites read from
`git fetch origin pull/2611/head:pr-2611-audit`. #2026 owns shell quoting; nothing here changes
quoting or the kernel-owned shell fragment representation.

## Accepted addressing grammar

Read from `adb help` on the measurement host (adb `1.0.41`, version `35.0.2-12147458`), not from the
two fields the current code models:

| Grammar form | Modelled today | Modelled in the prototype |
| --- | --- | --- |
| `-s SERIAL` | yes (scan + strip) | `target.selector = { kind: 'serial', serial }` |
| `-P PORT` | yes, managed rewrite only | `target.server = { kind: 'port', port }` |
| `-H HOST`, `-L SOCKET`, `-t ID`, `-d`, `-e`, `-a` | refused under a managed lease, invisible otherwise | `target.hostGlobals`, carried verbatim, refused under a managed lease |
| second `-s` (adb lets the later one win) | silently re-parsed positionally | kept as `hostGlobals` so it keeps its winning position |
| `wait-for[-TRANSPORT]-STATE` | prefix-stripped by `assertManagedAdbCommand` only | `target.waitFor`, then the real command is the tail |
| `-P9999` (attached form) | refused under a managed lease | `hostGlobals`, refused under a managed lease |

`serial` and `serverPort` are two of six owned selections. A proposal that types only those two
reproduces today's blind spot: an ambient `-H foreign.example` is invisible to every router.

## Routes, representation, and payload identity

Measured with a throwaway probe against the real root host binding (`payload = ['shell','input','tap','13','42']`);
"identity" asks whether the array that reaches the exec boundary is the caller's array.

| Route | Entry | Addressing on `main` | Addressing in the prototype | Payload identity |
| --- | --- | --- | --- | --- |
| Local device exec | `runAndroidAdb` → `createDeviceAdbExecutor` | `-s` stitched in the host binding, `-P`/`-s` re-scanned by `withServerPort` (`src/platform-runtime-android-adb-host.ts:164`) | `target` built once, host serialises | held (`command === payload`) |
| Ambient device, smuggled `-s` | same | emits `-s <device> -s <other>`; adb obeys the later one | `rawArgv` kept verbatim, same emitted argv | held |
| Managed device (lease port) | same, `serverPort` set | argv rebuilt twice (`adbInvocation` + `withServerPort`) | `applyManagedAndroidAdbServer` rewrites addressing only | held |
| Managed device, smuggled matching `-s` | same | slice + rebuild | re-slice at parse | **lost** (unavoidable: addressing arrives inside the payload) |
| Provider forwarding | `runCmd('adb', …)` inside `withAndroidAdbProvider` (`adb-provider-scope.ts:201` at HEAD, `:188`/`:204` at main) | `readAdbSerial` + strip, provider gets a rebuilt array | provider gets `invocation.command` | elementwise equal, **not** the caller's array |
| Managed host-level adb | host transport (`adb-provider-scope.ts:228` at HEAD) | `execHostAdb(['-s', scope.serial, …args])` | serial adopted into `target` | held at the host port |
| Managed server-port precedence | request `-P 9999` + lease `15038` | scan-and-replace, refusal on non `-P`/`-s` leading options | `applyManagedAndroidAdbServer` + `requireManagedAndroidAdbSerial` | argv identical (`-P 15038 -s …`), asserted in `src/platform-runtime-android-adb-host.test.ts` |
| Background spawn | `spawnSerialAdb` | `runCmdBackground` (always detaches internally) | `spawnAdb` | see Findings, detach policy |
| Limrun provider | `packages/provider-limrun/src/android.ts:193` | `['-s', serial, …args]` prefix | structural `LimrunAdbInvocation`, tunnel serial as addressing | provider payload kept argv-shaped for `@limrun/api` |
| Generic host command port | `host.commands.run({ executable: 'adb', args: ['-s', …] })` | flat argv, `[...request.args]` copies at `src/platform-runtime-host.ts:21` and `src/platform-runtime-operation-host.ts:60` | untouched by this spike | not measurable: still flat |

## Proposed API

`packages/platform-android/src/adb-addressing.ts` (241 lines at HEAD) owns grammar and managed policy:

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
addressing was actually present — `command` is the caller's array otherwise) and
`serializeAndroidAdbInvocation` (the single emitter; returns `rawArgv` verbatim when addressing was
never rewritten). Managed rules: `applyManagedAndroidAdbServer`, `requireManagedAndroidAdbSerial`,
`requireManagedAndroidAdbCommand`, `androidManagedAdbEnvironment`. The host port collapses
`execSerialAdb`/`spawnSerialAdb`/`execHostAdb` into `execAdb`/`spawnAdb` taking an invocation, so
`src/platform-runtime-android-adb-host.ts` nets **-53 lines**. The port-side test host still holds
its own copy of the lowering, but now calls the shared `applyManagedAndroidAdbServer` and serializer
instead of rebuilding `-P`/`-s` by hand.

## Numbers

| Measure | `main` | prototype |
| --- | --- | --- |
| Independently authored addressing/refusal owners | 11: serial scan + strip, scope-identity refusal, port precedence refusal, two host-level `-s` stitches, `withServerPort` scan + refusal, `assertManagedAdbCommand`, managed env lowering, detach-by-method-name, Limrun device prefix, Limrun host prefix, eight route-level `-s` stitches | 7 of them answer to `adb-addressing.ts`; scope-identity and port precedence stay in provider scope (they are scope questions, not grammar), detach became an explicit option on the device executor, and the eight route-level stitches wait for cut-set step 4 |
| Literal `'-s'` producers/consumers in production | 17 | 13 (3 in the owning module, 1 ambient escape, 8 untouched route sites) |
| New parsers/serializers | — | 1 parser, 1 serializer, 1 env builder |
| New bridges | — | 2, both in `provider-limrun` (structural `LimrunAdbInvocation`, and `limrunAdbArgv` to keep failure text identical) |
| Production LOC | — | `+481 -199` (net **+282**); outside the new 241-line module, net **+41** |
| Test LOC | — | `+255 -108`, all of it migrated assertions on the same argv expectations, no new synthetic executor |
| argv rebuild sites in the five transport files | 3 (`stripAdbSerialArgs`, `withServerPort`, app-log copy) | 2 (app-log copy, plus one `readonly`→mutable copy at the provider hand-off) |
| `readonly` payload propagation cost (executor payload → `readonly string[]`) | n/a | 96 type errors in 24 files, **1 in production source** (`adb-provider-scope.ts:57`, one `string[]` → `readonly string[]` widening) |

Gate status on the prototype: 118 files / 846 tests green (`packages/platform-android`,
`packages/provider-limrun`, `src/platform-runtime-android-adb-host.test.ts`,
`src/managed-device-reachability.test.ts`), plus 12 files / 59 tests green across the released-surface,
SDK, provider-scope, dialog-readiness and routing-parity lanes. Root `tsc -p tsconfig.json` reports 0
errors; `pnpm check:layering` and `pnpm lint` pass.

## Findings a migration must carry

- **The detach policy rode on the method name.** `execSerialAdb` detached, `execHostAdb` and
  `spawnSerialAdb` did not (`2cafab3ad0:src/platform-runtime-android-adb-host.ts:85`, `:95`, `:105`).
  Collapsing to one `execAdb` keyed on "target has a serial" silently detached host-level managed
  calls, which changes timeout/`killProcessTree` behaviour. The prototype carries the decision as an
  additive `AndroidAdbExecutorOptions.detached` set by the device-scoped executor only.
- **A hand-written typed guard disagreed with the shared rule on first contact.** The first version of
  `requireManagedAndroidAdbCommand` checked `command[0]`, while `assertManagedAdbCommand` finds the
  first token that is not `wait-for-*` (`2cafab3ad0:src/platform-runtime-android-adb-host.ts:189`).
  Three refusal cases (`wait-for-device kill-server`, `wait-for-device disconnect`,
  `wait-for-any-device pair …`) and every host-global selector (`-H`, `-L`, `-t`, `-d`, `-e`, `-P9999`)
  passed silently. The existing 21-selector loop in
  `src/platform-runtime-android-adb-host.test.ts` is what caught it; it is the oracle for this grammar
  and belongs in a golden table under `contracts/fixtures/` if the rules go cross-language.
- **The port carrier differed between the real host and the unit-test host.** The real lowering strips
  `serverPort` and emits `-P` plus `ANDROID_ADB_SERVER_PORT`/`ANDROID_ADB_SERVER_ADDRESS`; the
  in-package test host passed `serverPort` through untouched, so
  `packages/platform-android/src/__tests__/adb-executor.test.ts` asserted the stub's carrier, not the
  production one. Sharing `lowerAndroidAdbInvocation` moved that assertion to argv, where it is now the
  same contract. That shared lowering is a cut-set item, not a free win.
- **Flat ingress cannot be fixed downstream.** Provider forwarding and the eight generic host command
  port sites (`logs/runtime.ts` ×2, `network/runtime.ts` ×2, `readiness/runtime.ts`,
  `shutdown/runtime.ts`, `inventory.ts` via `host.commands.run`, and
  `src/platform-runtime-app-log-process.ts:187`) deliver one argv. There the payload is by definition
  re-sliced, and `[...request.args]` at `src/platform-runtime-host.ts:21` /
  `src/platform-runtime-operation-host.ts:60` copies it again. Identity survives only where the caller
  already separates addressing.
- **`@limrun/api` pins argv at the provider edge.** `LimrunAdbExecutor(args)` is handed to an external
  package, so the provider-facing executor stays argv-shaped; only the host port
  (`LimrunRuntimeDependencies.host.runAdb`) can be typed. `provider-limrun` declares no
  `platform-android` dependency, so the prototype duplicated the invocation structurally and mirrored
  argv for failure text — two bridges that a shared addressing home would remove.
- **Released surface is narrower than it looks.** `agent-device/android-adb` publishes
  `AndroidAdbExecutor`, `AndroidAdbExecutorOptions`, `AndroidAdbProvider` and nine `*WithAdb`
  helpers (`src/sdk/android-adb.ts`), so the executor payload must stay `(args: string[])` and
  `detached` must stay additive. `AndroidAdbHost` and `AndroidAdbInvocation` live on private workspace
  packages (`@agent-device/platform-android`, `@agent-device/provider-limrun`) and are not in the
  published export list, so they carry no external compatibility obligation.

## Recommendation: continue, with a smaller cut than the prototype

Continue. The typed representation moves seven independently authored addressing decisions into one
module, costs +41 production lines outside that module, and needs one production signature change to make
the payload read-only across the platform. Stop criteria are not met: bridges did not multiply (2, both
explained by a missing shared home), enforcement got one owner instead of three, and no lifecycle
behaviour needs to change once `detached` is an option. The cut set is:

1. Decide the addressing home first: a tiny `@agent-device/adb-addressing` package, or an explicit
   `provider-limrun` → `platform-android` edge. Do not ship the structural duplicate.
2. Land the addressing module + host port collapse (`execAdb`/`spawnAdb`) with
   `lowerAndroidAdbInvocation` exported from the platform package so the real and test hosts share it,
   and `detached` as an explicit option.
3. Move the managed refusal set and the grammar into a golden table under `contracts/fixtures/` and
   keep the 21-selector loop as the parity oracle.
4. Re-route the eight generic host command port adb calls to the android host port instead of
   `commands.run`; this is where the copies and the `-s` stitches actually disappear.
5. Type the provider host port (`host.runAdb`) and keep `LimrunAdbExecutor` argv-shaped.
6. Re-audit after #2611 lands: its `relayDeviceShellArgv` sites (6 in production, including the two
   generic-host copies) are the provenance relay this proposal should make unnecessary at steps 2 and 4.

Validation lanes for the production proposal: `pnpm test:unit packages/platform-android
packages/provider-limrun`, `pnpm test:unit src/platform-runtime-android-adb-host.test.ts
src/managed-device-reachability.test.ts src/sdk/limrun-runtime-dependencies.test.ts
src/__tests__/android-adb-public.test.ts`, `pnpm check:affected --run`, plus a device-backed pass
through `test/integration/provider-scenarios/android-lifecycle.test.ts` for screenshot/`exec-out`
binary results and background `logcat` spawn, which no unit lane covers.

## Unresolved evidence and pitfalls

- Device-backed verification was not run: this is a docs-only deliverable and the spike never claimed
  runner or on-device parity, only argv/refusal/identity parity against existing lanes.
- `pnpm typecheck` on `2cafab3ad0` fails in `packages/platform-android/src/__tests__/snapshot-helper-install.test.ts:29`
  (`installArgs` was dropped from `AndroidSnapshotHelperManifest` by `f07a4eca31` (#2618) while the
  fixture still sets it, added by `2cafab3ad0` (#2619)). Because `typecheck` chains with `&&`, that one
  package error means the root and `examples/sdk` projects are never checked. All root typecheck claims
  here come from running `npx tsc -p tsconfig.json` directly. Fix the fixture separately.
- `src/sdk/limrun-runtime-dependencies.test.ts > Limrun construction defers operation and
  opposite-platform helper modules` fails on pristine `main` on this host (real-time budget), so the
  eager-closure claim rests on import inspection instead: `adb-addressing.ts` imports only
  `@agent-device/kernel/errors`, and `src/__tests__/package-exports.test.ts` stays green.
- `pnpm check:production-exports` fails on `main` with 68 unused-export findings in 39 files
  (`packages/maestro`, `packages/capture-kit`, `src/runtime.ts`, …). None of those files is in this
  diff, and none of the exports this spike adds is flagged, so the count is unchanged; the gate was
  not green before and is not green now.
- Ambient routes keep argv authority: `rawArgv` wins at serialization, so on those routes `target` is
  advisory and the later `-s` still wins. Typing ambient addressing means choosing a precedence rule
  that today's behaviour does not have; that decision is unresolved and deliberately out of scope here.
- `pnpm stash`-style isolation is unusable for this kind of spike in parallel worktrees: `git stash`
  is scoped to the shared common git directory, so a `stash pop` in one worktree can apply another
  agent's stash. Use a commit on a spike branch and `git checkout --` to go back.
