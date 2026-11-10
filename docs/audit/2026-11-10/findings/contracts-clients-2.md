# Audit report: SLICE CONTR2 (second pass over contracts, daemon-contracts, daemon-client, client, session-journal)

## Coverage

This pass read what the CONTR report listed as "not reached". It repeats none of CONTR-1..19.

- Read fully, line by line (production source):
  - `packages/daemon-contracts/src`: `device-claims.ts`, `device-claim-settlement.ts`, `device-claim-record.ts`, `device-claim-inspection.ts`, `device-claim-store.ts`, `device-claim-paths.ts`, `device-claim-reboot.ts`, `device-claim-reconciliation.ts`, `device-claim-owner-recovery.ts`, `device-claim-recovery.ts`, `claim-recovery-gateway.ts`, `recovery-platform-scope.ts`, `daemon-registration-owner.ts`, `daemon-registration.ts`, `daemon-resolution.ts`, `daemon-stop.ts`, `daemon-startup-phases.ts`, `daemon-diagnostics-scope.ts`, `request-progress-protocol.ts`, `provider-credentials.ts`, `daemon-owner-cleanup.ts`. About 95% of the package's production lines (not read: `daemon-shutdown-report.ts`, first half of `session-repair-tombstone.ts`).
  - `packages/session-journal/src`: all production files (100%).
  - `packages/client/src`: `index.ts`, `client-normalizers.ts`, `screenshot-result.ts`, `client-identifiers.ts` (100% with the first pass's `lease-client.ts`).
  - `packages/daemon-client/src`: `daemon-client-lifecycle.ts`, `daemon-client-ensure.ts`, `daemon-client-startup.ts` lines 300-706, `daemon-client-liveness-probe.ts`, `daemon-launch-spec.ts`, `daemon-client-metadata.ts`, `daemon-client-ensuring.ts`, `daemon-client-lifecycle-request.ts`, `daemon-client-attach.ts`, `daemon-lifecycle-errors.ts`.
  - `packages/contracts/src`: `gesture-plan.ts`, `gesture-normalization.ts`, `scroll-gesture.ts`, `snapshot-visibility.ts`, `snapshot-model.ts`, top of `gesture-input.ts`.
- Tests: mechanical sweeps over all 174 test files of the slice (29.5k lines): weak-assertion patterns, assertions hidden in `catch`/`if`, duplicate titles, self-skips, real sleeps, process spawns, compile-only tests. Eleven test files were opened to confirm a hit. No test file was read end to end.
- Not reached: about 85% of `packages/contracts/src` (among them `platform-runtime-operations.ts`, `interaction-guarantees.ts`, `tap-keyboard-occlusion.ts`, `touch-runtime.ts`, `gesture-runtime.ts`, `snapshot-diagnostics.ts`, `snapshot-producers.ts`, `snapshot-runtime.ts`, `snapshot-capture-annotations.ts`, `replay*.ts`, `settings*.ts`, `application-lifecycle-*.ts`, `screenshot.ts`); `daemon-client-{binding,stop,request,proxy-upstream,address-hints,dispatch-disclosure}.ts`.
- Clean results: no `fallow-ignore` beyond one complexity directive (`gesture-normalization.ts:276`), no `@ts-ignore`/`as any` in production source, only three baselined entries for the slice in `fallow-baselines/health.json`. The lock ordering in `device-claims.ts` (host key before scoped key on every path) is consistent. The conditional assertions the sweep found are type narrowing after an equality assertion, not vacuous tests.

## Findings

### CONTR2-1: Device-claim paths block the daemon event loop with repeated synchronous `ps` spawns
- Category: inefficient
- Severity: medium     Confidence: high
- Evidence:
  - `readCurrentOwnerIdentity()` is uncached and spawns `ps -p <pid> -o lstart=` synchronously on every call (`packages/host-kit/src/internal/owner-identity.ts:27-29` -> `host-process.ts:282-289`), although a process's own start time never changes. The slice calls it at `packages/daemon-contracts/src/device-claim-store.ts:29` (every lock acquisition) and `device-claims.ts:175,255,331,388,455,516`.
  - `inspectDeviceClaimFile` spawns another synchronous `ps` per call (`device-claim-inspection.ts:101-106`). It is called at `device-claims.ts:102,144,191,259,329,450,509,598,759,818,834` and `device-claim-settlement.ts:116`.
  - `writeOwnedDeviceClaim` (`device-claims.ts:751-765`, behind `clearDeviceClaim`, `renewDeviceClaim`, `abandonDeviceClaim`) only compares `ownerToken`/pid/start time, yet pays the classification spawn plus a `daemon.json` read (`isSupersededDaemonOwner`).
  - `processOwnsActiveDeviceClaim` (`:507-519`) likewise needs only the decoded record.
  - One `open` or `transient-exclusive` command (admission `packages/daemon/src/core/composite-resource-admission.ts:130`, then acquire, then renew or clear) performs at least 7 blocking spawns, and reads the same claim file up to 3 times in `inspectDeviceClaimAcquisition` (`:182`, `:199` -> `:120` -> `:102`, then `settlement.ts:116`).
  - The startup sweep is N+1: `reconcileOrphanedDeviceClaims` inspects each file singly, twice (`:818,834`), while `inspectDeviceClaims` batches all pids in one snapshot (`device-claim-inspection.ts:49-51`).
  - Host-kit's own contract says a daemon request path must not use the sync probe (`host-process.ts:160-165,174-179`) and ships `readHostProcessIdentityObservationsAsync`. On Windows each probe is a CIM query.
- Fix: memoize the current process identity once per process (host-kit, or a module constant in `device-claim-store.ts`). Split a `readDeviceClaimRecord(path)` (decode only) from classification and use it in `writeOwnedDeviceClaim` and `processOwnsActiveDeviceClaim`. Classify through the async snapshot on acquisition paths. Batch the sweep. Files: `device-claim-inspection.ts`, `device-claims.ts`, `device-claim-settlement.ts`, `device-claim-store.ts`.
- Effort: M
- Model: opus (claim ownership and fail-closed semantics)
- Verify: counted-spawn test in `packages/daemon-contracts/src/device-claim-settlement.test.ts` asserting an acquire + clear pair makes at most one process-table read; `pnpm vitest run packages/daemon-contracts packages/daemon/src/resources/device`.

### CONTR2-2: `events` paging gives a tailing reader no cursor to resume from, and the fallback arithmetic is wrong
- Category: broken / inconsistent
- Severity: medium     Confidence: high
- Evidence:
  - `packages/session-journal/src/session-event-log.ts:219-240` sets `nextCursor` only when a line beyond `cursor + limit` exists. The last page, including a page that holds exactly `limit` lines, returns none (`:205`). The command layer passes that through unchanged (`packages/command-runtime/src/commands/observability/runtime/diagnostics-format.ts:35`).
  - `website/docs/docs/client-api.md:380` documents the opposite use: "Use `nextCursor` from the previous page to continue ... without replaying already uploaded/displayed events".
  - A caught-up reader can only compute `cursor + events.length`. `events` drops every line that fails `parseSessionEventLogLine` (`:197-200`, `:259-266`), while the cursor counts all non-blank lines (`session-event-log-lines.ts:112-116`). One unparsable or future-version line makes that sum undercount, so the reader replays events.
- Fix: always return the absolute index after the last line scanned (for example `nextCursor` on every page, or a separate `endCursor`) in `readSessionEventLogLines`. Update `diagnostics-format.ts`, the output formatter, and `client-api.md`.
- Effort: S
- Model: sonnet
- Verify: new cases in `packages/session-journal/src/__tests__/session-event-log-window.test.ts`: read to the end, append one event, resume from the returned cursor, get exactly that event, with a garbage line in the log.

### CONTR2-3: 54 daemon-client tests self-skip through a raw loopback probe that bypasses the "loopback required" guard
- Category: broken (tests)
- Severity: medium     Confidence: high
- Evidence:
  - `packages/test-kit/src/loopback.ts:33-45` provides `skipWhenLoopbackUnavailable`, which throws when `AGENT_DEVICE_REQUIRE_LOOPBACK_TESTS` is set.
  - 54 call sites in `packages/daemon-client/src/__tests__` instead use `if (!(await supportsLoopbackBind())) return t.skip(...)`: `daemon-client-lifecycle.test.ts` (17), `daemon-client-startup-race.test.ts` (9), `daemon-client-ensuring.test.ts` (9), `index.test.ts` (5), `index-policy-reuse.test.ts` (5), and seven more files. 40 other sites in the same package use the guarded helper.
  - The daemon startup, race, takeover and ensure suites therefore pass vacuously wherever loopback bind is denied, even with the guard on.
  - `AGENT_DEVICE_REQUIRE_LOOPBACK_TESTS` is set nowhere in the repo (no workflow, script or `package.json`), so no CI job enforces the guard at all.
- Fix: replace the raw pattern with `if (await skipWhenLoopbackUnavailable(t)) return;` in the 12 files. Set `AGENT_DEVICE_REQUIRE_LOOPBACK_TESTS=1` in the CI unit-test job (outside this slice).
- Effort: S
- Model: sonnet
- Verify: `git grep -n "supportsLoopbackBind())" packages/daemon-client` is empty; `AGENT_DEVICE_REQUIRE_LOOPBACK_TESTS=1 pnpm vitest run packages/daemon-client`.

### CONTR2-4: The launcher creates the state dir and `daemon.log` with default permissions; the daemon's `0o600` never applies
- Category: broken (hardening) / inconsistent
- Severity: low     Confidence: high
- Evidence: `packages/daemon-contracts/src/daemon-registration-owner.ts:297-298` runs `fs.mkdirSync(baseDir, { recursive: true })` and `fs.openSync(logPath, 'a')` with no mode, in the client, before the daemon exists. The daemon later opens the same file with `fs.openSync(logPath, 'a', 0o600)` (`:219`, `:236-240`), but a mode applies only at creation. A fresh state dir is therefore 0755 and `daemon.log` 0644 under a default umask. `daemon.json` (`:124`), the shutdown report (`:160`), and claim files and their directory (`device-claim-store.ts:15-19`) are deliberately 0600/0700.
- Fix: pass `mode: 0o700` to the `mkdirSync` and `0o600` to the launcher's `openSync`. One file.
- Effort: S
- Model: sonnet
- Verify: case in `packages/daemon-client/src/__tests__/daemon-launch-spec.test.ts` or a new `daemon-registration-owner` test asserting `fs.statSync(logPath).mode & 0o077 === 0` after `launchDaemonProcess` on a fresh dir (POSIX only).

### CONTR2-5: The journal re-spells contract vocabularies by hand, and its gesture list has already drifted
- Category: inconsistent
- Severity: low     Confidence: high (drift) / medium (user-visible effect)
- Evidence:
  - `packages/session-journal/src/session-event-action-presentation.ts:280,291` list gesture kinds as `['fling','pan','pinch','rotate','transform','tap']`. The response kind is `GestureIntent | 'drag'` (`packages/daemon/src/execution/interaction/internal/interaction-gesture-response.ts:8`; `GESTURE_KINDS` in `packages/contracts/src/gesture-input.ts:25-34`). A recorded `gesture drag` therefore summarizes as "Ran gesture" and loses `kind` in its details.
  - The same file hand-writes `SCROLL_DIRECTIONS` (`:24`, owner `contracts/src/scroll-gesture.ts:13`) and `['one-way','ping-pong']` (`:301`), while its sibling `session-event-action.ts:3,402` imports `SWIPE_PATTERNS` for the same field.
  - More bare literals: `['user-installed','all']` (`session-event-action.ts:353`, `session-event-request.ts:104`; owner `contracts/src/app-inventory.ts:3`) and keyboard `platform` `['ios','android']` (`presentation.ts:260`).
  - `readFirstString` (`presentation.ts:332-338`) duplicates `readFirstBoundedString` (`session-event-request.ts:268-277`).
- Fix: import `SCROLL_DIRECTIONS`, `SWIPE_PATTERNS` and a result-kind tuple exported from contracts (add `'drag'`). Export an `APPS_FILTERS` tuple from `contracts/app-inventory`. Delete `readFirstString`.
- Effort: S
- Model: sonnet
- Verify: new case in `packages/session-journal/src/__tests__/session-event-action.test.ts` for `action('gesture', { kind: 'drag', ... })` expecting "Ran drag gesture"; `pnpm tsc -b packages/session-journal`.

### CONTR2-6: `findNearestAncestor` rebuilds the whole node map on every call; the overlay path calls it twice per node
- Category: inefficient
- Severity: low     Confidence: high
- Evidence: `packages/contracts/src/snapshot-model.ts:219-227` calls `buildSnapshotNodeMap(nodes)` per call. `packages/capture-kit/src/screenshot-overlay.ts:76-78,190-201` calls it twice for every overlay source node inside the loop over `snapshot.nodes`; the array literal evaluates both calls even when the first candidate wins. That is O(sources x N) map construction per `screenshot --overlay-refs`. `packages/selectors/src/interaction-targeting.ts:325` has the same fallback when no index is passed. The same package already offers the map-taking form (`findSnapshotAncestor`, `createSnapshotVisibility().findAncestor`).
- Fix: make `findNearestAncestor` take a prebuilt `ReadonlyMap`, or remove it in favor of `SnapshotVisibility.findAncestor`. Build the map once in `buildScreenshotOverlayRefs` and evaluate the four candidates lazily.
- Effort: S
- Model: sonnet
- Verify: `pnpm vitest run packages/capture-kit/src/__tests__/screenshot-overlay*.test.ts packages/contracts/src/snapshot-model.test.ts`; `buildSnapshotNodeMap` called once per overlay build.

### CONTR2-7: `device release --stale` refusal-reason table carries unreachable entries and mislabels an unreadable claim file
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence: `packages/daemon-contracts/src/device-claims.ts:625-634` maps `owner-process-dead` and `owner-daemon-superseded` to `'claim-record-unreadable'`. Those two classifications are exactly the ones `deviceClaimOwnerCannotRelease` accepts, so with a decoded claim they are never refused (`:585`), and without one the classification is only `unknown` or `inconsistent` (`device-claim-inspection.ts:115-119,127,135`). `'claim-record-unreadable'` can never be emitted. A claim file that really cannot be read (EACCES, classified `unknown`) is reported as `'owner-liveness-unknown'`, which names the wrong cause. A whole-repo grep finds the string only at these two lines.
- Fix: branch on `!claim` first (`entry.error` set -> `claim-record-unreadable`, otherwise `claim-record-inconsistent`). Type the table as `Record<Exclude<DeviceClaimClassification, 'owner-process-dead' | 'owner-daemon-superseded'>, string>`.
- Effort: S
- Model: sonnet
- Verify: case in `packages/daemon/src/resources/device/__tests__/device-claims.test.ts` with a `chmod 000` claim file (skip when root) expecting `claim-record-unreadable`.

### CONTR2-8: Daemon lifecycle `reason` strings are re-typed literals in two naming conventions, against the owner file's own rule
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence: `packages/daemon-client/src/daemon-lifecycle-errors.ts:19-22` says "each reason is one constant here". The code does not follow it:
  - `'daemon_transport_timeout'` is a bare literal in 6 places (`daemon-client-timeout.ts:101`, `daemon-client-transport.ts:405,430,534,733`, `daemon-client-ensure.ts:193`).
  - `'daemon_retirement_unconfirmed'` in 3 (`daemon-client-lifecycle.ts:346`, `daemon-lifecycle-errors.ts:81`, `packages/daemon-contracts/src/daemon-stop.ts:145`).
  - `'daemon_registration_unproven'` in 2 (`daemon-lifecycle-errors.ts:226`, `daemon-client-startup.ts:608`).
  - `'daemon-record-unreadable'` in 2 (`daemon-lifecycle-errors.ts:238`, `daemon-client-attach.ts:19`).
  - `'daemon_transport_failure'` at `daemon-client-lifecycle-request.ts:29`.
  - `daemon-client-ensure.ts:74` throws `'daemon-lifecycle-contended'` twenty lines after importing `DAEMON_CONTENDED_REASON` (`'daemon-contended'`), a different reason with a near-identical name.
  - Half the family is kebab-case (`daemon-not-running`, `daemon-busy`, `daemon-drain-timeout`) and half snake_case.
  - Related: `daemon-client-lifecycle.ts:214` compares `rawTransport === 'dual'` case-sensitively, while `resolveDaemonTransportPreference` trims and lowercases (`daemon-resolution.ts:142-147`). `AGENT_DEVICE_DAEMON_TRANSPORT=Dual` gives preference `auto` but server mode `socket`.
- Fix: export one `DAEMON_CLIENT_REASONS` map from `daemon-lifecycle-errors.ts` (transport reasons from `daemon-client-transport.ts`) and use it at every producer and matcher. Normalize the `dual` comparison through the same helper. Do not rename wire values without a request, since callers branch on them.
- Effort: S
- Model: sonnet
- Verify: `git grep -n "'daemon_transport_timeout'" packages/daemon-client/src` returns one definition; `pnpm vitest run packages/daemon-client`.

### CONTR2-9: `apps.close` leaves Metro session hints that `sessions.close` clears
- Category: inconsistent
- Severity: low     Confidence: medium
- Evidence: `packages/client/src/index.ts:250-265` (`sessions.close`) clears the dev-server binding in a `finally` ("Close is teardown intent"). `:359-369` (`apps.close`) sends the same `close` command and clears nothing. The CLI routes `close <app>` to `apps.close` (`packages/command-surface/src/management/app.ts:230`), and `close [app]` ends the session unless the internal `closeAppOnly` flag is set (`packages/daemon/src/sessions/session-lifecycle/internal/session-close.ts:299-324`). After `agent-device close <app>` the session's Metro hints file survives. A later `metro reload` (`index.ts:412-420`) or a reused-session `open` (`packages/react-native/src/metro/metro-session-hints.ts:176-183`) reads a binding of a closed session.
- Fix: share one `closeSession` helper between both methods so both run the `finally` clear.
- Effort: S
- Model: sonnet
- Verify: case in `packages/client/src/__tests__/index-metro.test.ts`: prepare, `apps.close({ app })`, assert the hints file is gone.

### CONTR2-10: Claim reconciliation builds the dead owner's session dir without the `..` guard its sibling uses
- Category: broken (hardening; same class as CONTR-5, different site)
- Severity: low     Confidence: medium
- Evidence: `packages/daemon-contracts/src/device-claim-reconciliation.ts:33,92` uses `path.join(sessionsDir, safeSessionName(claim.session))`. `safeSessionName` keeps `.` and `..` (`packages/host-kit/src/session-paths.ts:3-5`). `device-claim-owner-recovery.ts:120` in the same transaction uses the guarded `resolveSessionDir`. `claim.session` comes from a file in the host-global claim store and is only checked for non-empty (`device-claim-record.ts:185`). A claim record with `session: ".."` makes reconciliation read durable-resource manifests from the state dir root and pass that path to the recovery functions.
- Fix: use `resolveSessionDir(sessionsDir, claim.session)` in both places; its throw is already mapped to `retained` by the surrounding `catch` (`:62-73`, `:107-118`).
- Effort: S
- Model: sonnet
- Verify: case in `packages/daemon-contracts/src/device-claim-reconciliation.test.ts` with `session: '..'` expecting `{ status: 'retained', reason: 'durable-resource-reconciliation-failed' }`.

### CONTR2-11: Event-log rotation: a failing rename drops every later event, and every read recounts the rotated generation
- Category: broken / inefficient
- Severity: low     Confidence: medium
- Evidence:
  - `packages/session-journal/src/session-event-log.ts:90-94` awaits `rotateSessionEventLogIfNeeded` before `appendFile` inside one `then`. If the rename (`session-event-log-window.ts:202,226`) or the sidecar write (`:224`) rejects (EPERM, EBUSY on Windows, ENOSPC), the append is skipped and only a `session_event_log_write_failed` diagnostic remains. The file stays over the cap, so every later event is dropped the same way. The function's doc promises "never blocks the append" (`:190-191`), which holds only for an unreadable sidecar.
  - Each `events` read runs `countLines(rotatedPath)` (`:171`, `:252-258`), a synchronous full scan of up to 5 MiB on the daemon event loop, plus three first-line reads and six `lstat`s, even when the cursor is in the active file. The count is fully determined by the inode/size/mtime token the same function already computes (`:266-281`).
- Fix: catch rotation failure separately and append anyway (the window is then at worst unverifiable, which is the documented degraded mode). Memoize `(rotated file token) -> lineCount`.
- Effort: S
- Model: sonnet
- Verify: test in `packages/session-journal/src/__tests__/session-event-log-window.test.ts` with `fs.promises.rename` stubbed to reject once, asserting the line still lands; counted `scanEventLogLines` calls across two consecutive reads.

### CONTR2-12: Launch spec still probes the superseded `dist/src/daemon.js` layout and keeps an unreachable throw
- Category: unneeded
- Severity: low     Confidence: medium
- Evidence: `packages/daemon-client/src/daemon-launch-spec.ts:38-46` lists `dist/src/daemon.js` as a second candidate. The build emits only `internal/daemon` (`scripts/build-entries.ts:19`), and the sole other reference repo-wide is a command-line matcher test (`packages/daemon-contracts/src/daemon-process.test.ts:6,28`). That matcher legitimately recognizes older running daemons; the launch spec only describes this tree. `:42-45` throws when `distPaths[0] === undefined` for a two-element array literal.
- Fix: reduce to the single `dist/src/internal/daemon.js` path (drop `distPaths` from the spec and from the `Daemon entry not found` details), unless the lead confirms a packaging mode that still emits the old path.
- Effort: S
- Model: sonnet
- Verify: `pnpm vitest run packages/daemon-client/src/__tests__/daemon-launch-spec.test.ts`; `git grep -n "'dist', 'src', 'daemon.js'"` is empty.

### CONTR2-13: Second viewport-root predicate in the file that declares "one definition for the whole repo"; two ancestor walkers disagree
- Category: inconsistent
- Severity: low     Confidence: medium
- Evidence:
  - `packages/contracts/src/snapshot-visibility.ts:107-131` states `isViewportRootNode` is the single definition and must read `type`, `role` and `subrole`, because a macOS window with a non-standard subrole is not recognizable from `type`. `isUsefulVisibilityAnchor` (`:248-269`) re-tests `type.includes('application') || type.includes('window')` on `type` alone, so the macOS case the comment describes is treated as a useful anchor.
  - `findSnapshotAncestor` (`snapshot-model.ts:200-216`) resolves a parent by index "with an array-offset fallback" (`nodes[current.parentIndex]`). `findNearestScrollableAncestor` (`snapshot-visibility.ts:216-232`) walks the same links with no fallback. The same tree yields different ancestors when an index is missing from the map.
- Fix: call `isViewportRootNode(node)` from `isUsefulVisibilityAnchor` (widen its `Pick`). Implement `findNearestScrollableAncestor` on `findSnapshotAncestor`, or delete the offset fallback if no producer needs it.
- Effort: S
- Model: opus (touches visibility judgement used by selectors and maestro)
- Verify: `pnpm vitest run packages/contracts/src/snapshot-visibility*.test.ts packages/selectors packages/maestro`.

### CONTR2-14: Seven more tests that assert nothing at runtime (beyond the two files in CONTR-17)
- Category: broken (tests)
- Severity: low     Confidence: high
- Evidence: `packages/session-journal/src/__tests__/journal-request-input.test.ts:77,108` (2 tests) and `packages/contracts/src/client-settings.test.ts:31-60` (5 of 7 tests) contain only `expectTypeOf` calls. Vitest typecheck mode is not configured (`vitest.config.ts` has no `typecheck`), so these are runtime no-ops; `tsc -b` proves them because test files are in each package's `include`. They report as seven passing tests.
- Fix: move the type proofs to `*.type-proof.ts` files compiled by `tsc -b` (the direction CONTR-17 proposes), or enable `typecheck` for these files so the runner executes them.
- Effort: S
- Model: sonnet
- Verify: `pnpm typecheck`; test count drops by seven with no runtime coverage change.

### CONTR2-15: `releaseAfterRetirement` can turn a retirement result into a rejection through an unguarded diagnostic write
- Category: broken
- Severity: low     Confidence: medium
- Evidence: `packages/daemon-contracts/src/daemon-registration-owner.ts:617-619` awaits `recordRegistrationWarning(...)` with no catch. The other three call sites of the same helper swallow its failure (`:163-167`, `:197-201`). The helper writes to `logPath` inside the state dir (`:651-659`). The path is reached when the lock release fails after `retirePrivateStateIfEligible` may have removed that directory (`:703`). A throw there replaces the typed `DaemonRetirementResult` that `stopAndRetireDaemon` callers switch on (`daemon-client-lifecycle.ts:320-357`).
- Fix: add `.catch(() => {})` at `:619`.
- Effort: S
- Model: sonnet
- Verify: test in `packages/daemon-contracts/src/daemon-stop.test.ts` with a release that rejects and an unwritable `logPath`, expecting a `retained` result.

### CONTR2-16: History-narrating comments in the daemon-client lifecycle and the tombstone reader (AGENTS.md comment rule; sites not listed in CONTR-16)
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence: `packages/daemon-client/src/daemon-client-lifecycle.ts:267-283` ("BLOCKER 2, third follow-up"), `:294-314` ("R7 (Fix 1, C1)", 20 comment lines inside one `if` condition), `:360-374`, `:400-413`, `:421-428`; `packages/daemon-contracts/src/session-repair-tombstone.ts:100-113`; `packages/daemon-contracts/src/request-progress-protocol.ts:2-4`. They narrate review rounds and name functions in other packages (`finalizeRepairTeardown`, `repairExpiredIfTombstoned (request-router.ts)`) that a rename silently invalidates. `daemon-launch-spec.ts:28` says "~8 existence probes" for code that makes five.
- Fix: cut each to the one constraint the code cannot show (keep the daemon when `repairSessionHeld`; keep it when `sessionActive`; never delete a state dir holding an unrecovered tombstone) and point to ADR 0012 / ADR 0016 for the rest.
- Effort: S
- Model: sonnet
- Verify: `pnpm format && pnpm vitest run packages/daemon-client`.
