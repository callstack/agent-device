# ADR 0022: Daemon — Platform Runtime Coupling Audit and Ownership Ratchets

## Status

Accepted (2026-09-06). This ADR implements issue #2278's audit deliverables.
Gates enforce the classification inventory and structural no-regrowth checks.
The ADR records decisions and references gates instead of duplicating the inventory.

Amended 2026-10-11 by #3431.
Daemon-runtime composition edges moved from `packages/daemon/src/` to process-root `src/daemon-composition.ts`:

- Gateway, diagnostics, resource-cleanup, and lifecycle edges.
- Provider-runtime hubs.
- Dynamic platform-services and claim-recovery edges.

R76 excludes that root module because it is outside the daemon zone.
#3430 then moved the leaked `packages/daemon/src/core/direct-ios-selector.ts` query through the request-bound runtime binding.
The R76 inventory became empty.
As its retirement criterion required, R76 became a coupling ban and removed classification machinery.
Section 2 retains the classification outcomes. Git history retains the completed classification procedure.

## Rules at a glance

- R76 prohibits production daemon imports of root `src/platform-runtime-*.ts` modules or root hubs that reach them.
- Apple session observation uses neutral `AppleSessionObservation`.
- Platform owners participate through existing lifecycle phases. There is no generic hook collection.
- Open-target plans/results remain separate from platform mechanics, with one construction path.
- R75 permits handler-owned state-shape and store-authority file sets to shrink, but never grow beyond the merge-base.
- Route reduction is limited to hops that the deletion test proves removable.
  The ≤14 target is superseded.

## 1. Context

R65 prohibits every form of direct production dependency from `packages/daemon/src/**` to concrete platform code.
The platform-package migration established this boundary.
It did not prove that each remaining platform-aware responsibility belongs in the daemon.
At baseline `658f822c`, nine daemon files had 13 production imports of root `src/platform-runtime-*.ts` composition modules.
At measurement commit `27a97ee619`, those nine files had 14 edges.
One file imports and re-exports the same symbol.

R7/R10 ratcheted `SessionState` write ownership.
They did not ratchet broad state reads or `SessionStore` authority.
The ADR 0019 trace recorded routes of approximately 24 files without an accepted budget or owning issue.
#2278 audited all four concerns at `27a97ee619`.

## 2. Decision

1. **R76 prohibits daemon coupling to root platform-runtime modules.**
   Any production `packages/daemon/src/**` import of `src/platform-runtime-*.ts` or a root hub that reaches this family violates R76.
   This includes static and dynamic forms.
   Git history retains the completed classification procedure.
   The outcomes below retain its rationale.

2. **Per-edge outcomes at `27a97ee619`.**
   The audit retained four composition-essential edges for process-root assembly:
   - `daemon-runtime.ts` → `platform-runtime.ts`: composed gateway.
   - `daemon-runtime.ts` → `platform-runtime-host-diagnostics.ts`: host diagnostics.
   - `device-claim-owner-recovery.ts` → `platform-runtime.ts`: owner recovery.
   - `device-ready.ts` → `platform-runtime-device-ready.ts`: device readiness.

   The remaining nine edges exposed platform mechanics. Their owners or follow-ups are below:
   - **Apple session observation.**
     `AppleSessionObservation` supplies runner liveness/session identity and the sole-foreground-app observation.
     Recording health, device refresh, and open-hint policy consume it.
     Root composition supplies request-local inventory and its error classifier.
     `packages/platform-apple` owns the probes.
     The three consumers are daemon-policy-essential.
     Selector production and lifecycle participation remain separate.
   - **#2333 (done): platform resource-owner lifecycle participation.**
     The `apple-runner-owner` and `operation-host` edges are retired.
     `daemon-runtime.ts` holds only typed `PlatformOwnerLifecycle` from `packages/daemon/src/core/platform-owner-lifecycle.ts`.
     Root `platform-runtime-daemon-lifecycle.ts` composes it.
     That module alone imports the Apple runner owner, Android snapshot-helper cleanup, Web orphan cleanup, and legacy app-log marker recovery.
     The retained `resource-cleanup` edge became composition-essential and carried only `platformResourceCleanup`.
   - **Open-target planning (done, #2334).**
     `platform-runtime-open-target.ts` retains only the neutral open plan/result surface:
     - `resolveRequestedOpenSurface`
     - `validateOpenRelaunchTarget`
     - `resolveSessionAppBundleIdForTarget`
     Android `resolveAndroidPackageForOpen` and `inferAndroidPackageAfterOpen` moved behind their owner in `packages/platform-android`.
     `session-open-prepare.ts` consumes surface and relaunch-target policy.
     `session-selector-dispatch.ts` consumes the app-bundle-identity resolver.
     Both edges are daemon-policy-essential.
     The resolver remains the single construction path for the open plan.
   - **#2273/#2274 (done): selector query.**
     The `direct-ios-selector.ts` → `queryAppleRuntimeSelector` edge is retired.
     Live reads use `querySelector` on the request-bound owner.
     `SelectorObservationRuntimeOperations` declares it CONDITIONAL on captured touch and gesture uses.
     Off-screen rescue (#1542) thus uses the command's admitted binding.
     It adds no second selector producer.

3. **Measure session state/store authority by symbol and ratchet the handler-owned portion.**
   At `27a97ee619`, the repository overlay contains 112 `SessionState` shape edges and 68 `SessionStore` authority edges.
   The handler-owned portion contains 14 shape files and 22 authority files under `packages/daemon/src/{sessions,execution}/handlers/**`.
   R75 `session-authority-overlay` holds these file sets at or below the merge-base.
   `measureRatchets` in `scripts/layering/ratchet-reference.ts` measures the reference.
   Handlers may lose files from either set. They may never gain files.
   Classification permits this ratchet.
   R7/R10 logical-module declarations own cross-module reads outside this handler path.
   R75 does not ratchet those reads.

4. **The repeated hop trace assigns roles and tests deletion.**
   Roles are policy, orchestration, translation, adapter, and pass-through, with a terminal marker.
   Each pass-through/translation hop receives a deletion test.
   [ADR 0023](0023-end-state-hop-trace.md) records 41 hops for `press`/Android and 47/49 per arm for `snapshot`/iOS.
   The snapshot route shares 30 hops, then adds 17 for the AX bridge or 19 for the runner fallback.
   Only one distinct hop is proven removable: `commands/runtime-types.ts`.
   Auth comparison, cancellation, idle-reap reset, and Android freshness guard/clear are side-calls, not hops.
   The earlier ≤14 target is superseded.
   It requires combination of cross-cutting request-scope wrappers, which this audit does not endorse.

5. **Decisions by audit area.**
   - Apple session observation consumes neutral `AppleSessionObservation`.
   - Runtime lifecycle participation uses the existing lifecycle phases, without generic hooks (#2333).
   - Open-target planning separates plan/result from platform mechanics and preserves one construction path.
   - Session state/store authority retains its access structure and ratchets the handler-owned portion through R75.
   - Route depth records the new trace and permits combination only of proven pass-through hops.
     This change combines none.

## 3. Rationale

- **The inventory was a registry, not a prose duplicate.**
  #2278's 13 imports were review candidates, not presumed violations.
  A neutral runtime interface can be the correct ownership boundary.
  Only a machine-readable table with per-edge categories made the classification decision enforceable by the layering gate.
  It detected changed edges through drift and staleness failures, not warnings.
- **Categories 1 and 2 remain; category 3 needs deeper interfaces.**
  Composition-essential edges assemble neutral implementations at the process root.
  Daemon-policy-essential edges own admission, sessions, conflicts, locks, cancellation, teardown order, artifact publication, or response/event semantics.
  Leaked platform mechanics are family operations or state that belong behind a deeper interface or adapter.
  Only this third category required implementation work.
  Three child issues for the nine leaked edges permitted independent review and preserved each consumer's behavior.
  The selector edge is deliberately outside #2332.
  #2273/#2274 already owned that boundary; another producer would duplicate snapshot-producer policy.
- **R75 ratchets handler files, not the complete overlay.**
  The repository's 112/68 sets include correct owning-module reads, such as session lifecycle reads of session state.
  A repository-wide ratchet would prevent legitimate movement.
  The handler-owned ratchet targets the regression from #2278: additional handler access to state shape and store authority.
  The fresh audit found no owner for this portion.
- **The hop target is retired.**
  The routes measured at `132ffe1da` grew from 23/24 to 41 / 47-49.
  New request-scope wrappers, the AgentDevice command layer, the adb host split, and dual-arm snapshot capture explain the growth.
  Every retained hop now has a documented role.
  Each pass-through/translation hop also has a retained-depth or removable verdict.
  The one proven removable hop is the only endorsed combination.

## 4. Enforced by

- R76 `daemon-platform-runtime-inventory` in `scripts/layering/check.ts`.
  Since the 2026-10-12 amendment, it prohibits coupling instead of maintaining a classification table.
  The inventory is empty and its machinery is deleted.
- R75 `session-authority-overlay` in `scripts/layering/check.ts`.
  Both R75 and R76 failed against planted violations before acceptance.
- R7 `session-state-ownership` and the R10 merge-base ratchet for owning modules.
- R65, which prohibits concrete platform imports and supplies the basis for this audit.
- Completed child issues #2333, #2334, and #2273/#2274 with the `querySelector` runtime operation; see §2.2.
