# ADR 0022: Daemon — Platform Runtime Coupling Audit and Ownership Ratchets

## Status

Accepted (2026-09-06). Implements the audit deliverables of issue #2278. The classification
inventory and the structural no-regrowth checks are gate-enforced; this ADR records the decisions
and points at the gates rather than restating the inventory.

## 1. Context

The platform-package migration removed direct production dependencies from `src/daemon/**` to
concrete platform code (R65: zero such imports in every form). What it did not prove is that
every remaining platform-aware responsibility belongs in the daemon. At the audit baseline
(`658f822c`) nine daemon files held 13 production imports of root `src/platform-runtime-*.ts`
composition modules; at the measurement commit (`27a97ee619`) the count is 14 edges across the
same nine files (one file holds an import and a re-export of the same symbol).

`SessionState` write ownership was ratcheted (R7/R10), but broad state reads and `SessionStore`
authority were not. The ADR 0019 hop trace recorded routes of ~24 files with no accepted budget
or owning issue. #2278 audited all four concerns at `27a97ee619`.

## 2. Decision

1. **Every daemon import of a root `src/platform-runtime-*.ts` module is classified as exactly
   one of three categories**, and the classification is owned by the machine-readable inventory
   `DAEMON_PLATFORM_RUNTIME_EDGES` in
   [`scripts/layering/daemon-platform-runtime-inventory.ts`](../../scripts/layering/daemon-platform-runtime-inventory.ts):
   - **Composition-essential** — assembling neutral runtime implementations at the process root.
   - **Daemon-policy-essential** — request admission, session ownership, conflicts, locking,
     cancellation, teardown ordering, artifact publication, or response/event semantics.
   - **Leaked platform mechanics** — platform-family operations or state that should be owned
     behind a deeper runtime interface or adapter; only this category creates implementation
     work (child issues below).
   The gate rule **R74 `daemon-platform-runtime-inventory`** (in `scripts/layering/check.ts`)
   fails the layering check on any unclassified edge, on symbol-set drift between a file and its
   inventory entry, and on stale entries. Observed red against a planted unclassified import
   before acceptance.

2. **Per-edge outcomes at `27a97ee619`.** Four edges are composition-essential and stay
   (`daemon-runtime.ts` → `platform-runtime.ts` and → `platform-runtime-host-diagnostics.ts`;
   `device-claim-owner-recovery.ts` → `platform-runtime.ts`;
   `device-ready.ts` → `platform-runtime-device-ready.ts` — process-root assembly of the
   composed gateway, host diagnostics, owner recovery, and device readiness). The remaining
   nine edges are leaked platform mechanics and are owned by:
   - **#2332** — Apple runner session observation behind a semantic port
     (`request-recording-health.ts`, `session-device-resolution.ts`, `ios-app-session-hint.ts`
     → `inspectAppleRunnerSession` / `resolveSoleForegroundIosApp`).
   - **#2333** — lifecycle participation of platform resource owners
     (`daemon-runtime.ts` → `platform-runtime-apple-runner-owner.ts`,
     `platform-runtime-resource-cleanup.ts`, and the dynamic
     `platform-runtime-operation-host.ts` import).
   - **#2334** — open-target planning separated from platform mechanics
     (`session-open-prepare.ts`, `session-selector-dispatch.ts` →
     `platform-runtime-open-target.ts`), blocked by #2332.
   - **#2273/#2274** (existing) — `direct-ios-selector.ts` → `queryAppleRuntimeSelector` is the
     selector seam those issues own; coordination was posted there rather than opening a second
     selector producer.

3. **Session state and store authority are measured as a symbol-level overlay and ratcheted
   on the handler-owned slice.** At `27a97ee619` the overlay is 112 `SessionState` shape edges
   and 68 `SessionStore` authority edges repo-wide, of which 14 shape / 22 authority files are
   handler-owned (`src/daemon/handlers/**`). Gate rule **R75 `session-authority-overlay`**
   (reference measured via `measureRatchets` in `scripts/layering/ratchet-reference.ts`) holds
   the handler-owned file sets at or under the merge-base: handler code may lose files from
   either set, never gain them. The ratchet is added now that the edges are classified;
   cross-module reads outside `src/daemon/handlers/**` are owned by the logical-module
   declarations (R7/R10) and are not ratcheted here.

4. **The entry-to-platform hop trace was re-run with hop roles**
   (policy / orchestration / translation / adapter / pass-through + terminal) and a deletion
   test per pass-through/translation hop. The updated artifact is
   [`0019-end-state-hop-trace.md`](0019-end-state-hop-trace.md): 44 hops for `press`/Android and
   51/53 per arm for the now dual-arm `snapshot`/iOS route (shared 34 + AX bridge 17 / runner
   fallback 19). The deletion test proves only three distinct removable hops
   (`daemon-idle-reap.ts`, `session-snapshot-freshness.ts`, `commands/runtime-types.ts`); the
   earlier ≤14 target is superseded and not reachable without folding cross-cutting
   request-scope wrappers, which the audit does not endorse.

5. **Per-audit-area decisions.** Apple selector/session observation: deepen an existing
   interface (#2332). Runtime lifecycle participation: deepen through the existing lifecycle
   phases, no generic hook bag (#2333). Open-target planning: separate plan/result from
   platform mechanics, one construction path preserved (#2334). Session state/store authority:
   keep the current access shape, ratchet the handler-owned slice (R75). Route depth: record the
   re-traced routes; collapse only the proven pass-through hops (none undertaken in this
   change).

## 3. Rationale

- **The inventory is a registry, not a prose copy.** #2278's 13 imports are a review inventory,
  not 13 presumed violations; a neutral runtime interface may be the correct owning seam. A
  machine-readable table with per-edge categories is the only form of the decision that the
  layering gate can enforce, and it is the form that stays honest as edges move: drift and
  staleness are failures, not warnings.
- **Category 1 and 2 stay; category 3 deepens.** Splitting the nine leaked edges into three
  child issues (instead of one refactor) keeps each independently reviewable and preserves the
  existing behavior each surface depends on. The selector edge is deliberately not a child of
  #2332: #2273/#2274 already own the selector seam, and a second producer would duplicate
  snapshot-producer policy.
- **R75 ratchets the handler slice, not the whole overlay.** The repo-wide 112/68 edge set
  includes owning-module reads that are correct (session lifecycle reading session state).
  Ratcheting the whole set would freeze legitimate movement; ratcheting the handler-owned set
  targets the exact regression #2278 flagged — handlers accreting state shape and store
  authority — and is the slice the fresh audit found unowned.
- **The hop target is retired, not missed.** The 23/24 routes measured at `132ffe1da` grew to
  44 / 51-53 because the request-scope wrapper layer, the AgentDevice command layer, the adb
  host split, and the dual-arm snapshot capture all landed on the traced paths. Every retained
  hop now carries a documented role and, for pass-through/translation hops, a kept-depth or
  removable verdict; the three proven-removable hops are recorded as the only endorsed
  collapse.

## 4. Enforced by

- R74 `daemon-platform-runtime-inventory` and R75 `session-authority-overlay` in
  `scripts/layering/check.ts` (both observed red against planted violations before acceptance).
- R7 `session-state-ownership` and the R10 merge-base ratchet for the owning-module slice.
- R65 for the concrete-platform-import ban this audit builds on.
- Child issues #2332, #2333, #2334 (and #2273/#2274 for the selector seam) for the category-3
  implementation work.
