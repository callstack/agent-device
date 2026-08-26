// R7 session-state ownership.
//
// `SessionStore.get()` hands back the live `SessionState` out of a private Map, and `set()`
// re-puts the same reference — so a `session.<field> = …` anywhere in the daemon is a durable
// write to store-owned state, and whether it persists depends on aliasing rather than on an
// API call. That is workable while each field has an owner that keeps its invariants; it stops
// being workable the moment a field's rule is spread across modules, because nothing at the
// store boundary can check it.
//
// So the ownership is written down here and enforced. The table is not an aspiration: it is
// the set of writers that exist, so the gate's job is to stop the set from growing quietly.
// Adding a field to `SessionState` forces a deliberate owner; writing an existing field from
// a new module fails until that module is either declared an owner or, better, calls the
// owner instead. ADR 0014's ref frame is the worked example — its four fields moved together
// across two modules until `activateRefFrame` took the transition.
//
// Detection is AST-based (`oxc-parser`, already a devDependency) rather than a line regex. A
// regex has to enumerate assignment operators, and the ones it forgets are exactly the ones
// that slip through: `??=` on an optional field is the natural way to write a default, and a
// computed `session[key] =` hides the field name entirely. The parser reports every
// assignment and update form for free, and a `session.a.b = …` sub-object write is reported
// as what it is rather than mistaken for a write to `a`.

import { parseSync } from 'oxc-parser';
import path from 'node:path';

export type SessionStateWrite = {
  file: string;
  line: number;
  field: string;
};

/**
 * Which modules may write each `SessionState` field, as paths under `src/`. A field whose
 * owner list has one entry is a field only that module can get wrong.
 */
export const SESSION_STATE_FIELD_OWNERS: Readonly<Record<string, readonly string[]>> = {
  // ADR 0014 ref frame: the four frame fields move together or the frame is incoherent, so
  // both issuance forms go through ref-frame.ts.
  refFrameState: ['src/daemon/ref-frame.ts'],
  refFrameScope: ['src/daemon/ref-frame.ts'],
  refFrameTree: ['src/daemon/ref-frame.ts'],
  refFrameGeneration: ['src/daemon/ref-frame.ts'],
  // Scoped-snapshot lineage is cleared at two distinct events: crossing a device side-effect
  // seam (ref-frame.ts) and replacing the stored observation (session-snapshot.ts).
  snapshotScopeSource: ['src/daemon/ref-frame.ts', 'src/daemon/session-snapshot.ts'],
  snapshot: ['src/daemon/session-snapshot.ts'],
  snapshotGeneration: ['src/daemon/session-snapshot.ts'],
  lastComparisonSafeSnapshot: ['src/daemon/session-snapshot.ts'],
  androidSnapshotFreshness: ['src/daemon/session-snapshot-freshness.ts'],
  // One-shot deferred-warning latch (#1587 follow-up): the transition function is the only
  // writer, so the latch's window semantics live in a single module.
  recoveredSnapshotWarningLatch: ['src/daemon/snapshot-quality-latch.ts'],

  // #1478 P4a script publication. The tagged aggregate replaced the eight co-resident
  // `saveScript*`/`scriptRecordingState`/`repair*` fields; its ONLY writers are the two
  // daemon-private projections (`session-replay-transaction.ts`,
  // `session-script-publication-capability.ts`) and the writer's commit transition.
  // It also absorbed `recordSession`, whose separate ownership let handler surfaces arm
  // recording without moving the lifecycle that authorized it (#1533). Recording is now derived
  // (`isRecordingPublication`), so there is no second field to keep in step.
  scriptPublication: [
    'src/daemon/session-replay-transaction.ts',
    'src/daemon/session-script-publication-capability.ts',
    'src/daemon/session-script-writer.ts',
  ],
  // #1478 P4b: moved from `session-replay-resume.ts` into the `ReplayCoordinator`
  // (`session-replay-coordinator.ts`) — the one locked gateway a native replay request uses to
  // reach both this watermark and the P4a `scriptPublication` transitions above.
  pendingRecordAndHeal: ['src/daemon/session-replay-coordinator.ts'],

  trace: ['src/daemon/handlers/trace-runtime.ts'],
  pendingInteractionOutcome: ['src/daemon/interaction-outcome-policy.ts'],
  postGestureStabilization: ['src/daemon/deferred-interaction-outcome.ts'],

  // Snapshot lineage on a freshly BUILT record. snapshot-command-runtime.ts constructs a new
  // SessionState rather than mutating the stored one, so it cannot call setSessionSnapshot —
  // but the rule is the same, so the two-field transition lives in session-snapshot.ts.
  appName: ['src/daemon/snapshot-command-runtime.ts'],
  // Open execution owns the paired lease/claim transition after the handler has admitted one
  // lifecycle binding. Keeping the records together prevents request-policy routing from gaining
  // a second durable owner as the execution seam stays package-bound.
  lease: ['src/daemon/handlers/session-open-execution.ts'],
  deviceClaim: ['src/daemon/handlers/session-open-execution.ts'],

  // #1398 (ADR 0017 session-scoped echo protection amendment): the ephemeral
  // literal->placeholder registry is populated and consulted only at the
  // recorder's single choke point.
  recordedFillLiterals: ['src/daemon/session-action-recorder.ts'],
};

/**
 * Fields no daemon module writes through a session binding: they are set when the record is
 * constructed (an object literal, not a field assignment) or inside `session-store.ts`, which
 * owns the record and is excluded from the scan.
 *
 * This list exists so the classification is EXHAUSTIVE. Without it, a new `SessionState` field
 * that happened to have no direct write would satisfy the gate by being invisible to it, and R7
 * would silently stop covering part of the type it claims to cover. Being here is a positive
 * claim — "the store establishes this, nothing mutates it later" — so acquiring a direct write
 * fails the gate until the field is moved into `SESSION_STATE_FIELD_OWNERS` with a real owner.
 */
export const STORE_OWNED_SESSION_STATE_FIELDS: ReadonlySet<string> = new Set([
  'actions',
  'appBundleId',
  'appLog',
  'appLogFailure',
  'audioProbe',
  'createdAt',
  'device',
  'lastPerfProfile',
  'name',
  'recordOnlySession',
  'perfCapture',
  'screenRecording',
  'sessionScope',
  'snapshotDiagnostics',
  'surface',
]);

export function sessionStateFieldCount(): number {
  return Object.keys(SESSION_STATE_FIELD_OWNERS).length + STORE_OWNED_SESSION_STATE_FIELDS.size;
}

export type FieldClassificationDrift = {
  field: string;
  problem: 'unclassified' | 'both' | 'not-a-field';
};

/**
 * Where the two ownership tables disagree with `SessionState` itself. Empty means every declared
 * field is classified exactly once and neither table names a field that no longer exists.
 */
export function fieldClassificationDrift(fields: readonly string[]): FieldClassificationDrift[] {
  const declared = new Set(fields);
  const owned = new Set(Object.keys(SESSION_STATE_FIELD_OWNERS));
  const drift: FieldClassificationDrift[] = [];

  for (const field of fields) {
    const inOwners = owned.has(field);
    const inStore = STORE_OWNED_SESSION_STATE_FIELDS.has(field);
    if (inOwners && inStore) drift.push({ field, problem: 'both' });
    else if (!inOwners && !inStore) drift.push({ field, problem: 'unclassified' });
  }
  for (const field of [...owned, ...STORE_OWNED_SESSION_STATE_FIELDS]) {
    if (!declared.has(field)) drift.push({ field, problem: 'not-a-field' });
  }

  return drift.sort((left, right) => left.field.localeCompare(right.field));
}

/**
 * Field names declared by `SessionState` itself, so the scan cannot be fooled by a daemon
 * module with an unrelated local named `session` (a provider session, a runner session).
 */
export function sessionStateFields(typesSource: string): string[] {
  const declaration = /export type SessionState = \{([\s\S]*?)\n\};/.exec(typesSource);
  if (!declaration) throw new Error('SessionState declaration not found in daemon/types.ts');
  return [...declaration[1]!.matchAll(/^ {2}([a-zA-Z][A-Za-z0-9]*)\??:/gm)].map(
    (match) => match[1]!,
  );
}

/**
 * Whether a binding holds a `SessionState`. The daemon names these records by role, not always
 * `session`: `nextSession`, `provisionalSession`, `completedSession`, `preRunSession`,
 * `preEntrySession`, `activeSession`. Matching only the literal name `session` is what let three
 * genuine foreign writes sit unreported — `nextSession.snapshotGeneration` in snapshot-runtime.ts
 * among them — while the gate claimed every write was inside its owner.
 *
 * There is no type information here, so this is a name test, and it is deliberately paired with
 * the declared-field filter in `findSessionStateWrites`: a binding must look like a session AND
 * the field must be one `SessionState` declares. A provider or runner session that happens to be
 * named `…Session` only registers if it also writes a field name `SessionState` owns, and the
 * remedy then is to declare the owner — the same remedy as for a real write.
 */
function isSessionBinding(name: string): boolean {
  return /session/i.test(name);
}

/** A member expression being assigned to, or updated with `++`/`--`. */
type WriteTarget = {
  object: string | undefined;
  field: string | undefined;
  computed: boolean;
  offset: number;
};

function writeTarget(node: Record<string, unknown>): WriteTarget | null {
  const type = node['type'];
  const member =
    type === 'AssignmentExpression'
      ? (node['left'] as Record<string, unknown> | undefined)
      : type === 'UpdateExpression'
        ? (node['argument'] as Record<string, unknown> | undefined)
        : undefined;
  if (!member || member['type'] !== 'MemberExpression') return null;
  const object = member['object'] as Record<string, unknown> | undefined;
  const property = member['property'] as Record<string, unknown> | undefined;
  return {
    // Only a direct `<identifier>.field` write is a session write; `a.b.c = …` writes into a
    // sub-object and its `object` is a MemberExpression, so it has no identifier name here.
    object: object?.['type'] === 'Identifier' ? (object['name'] as string) : undefined,
    field: property?.['type'] === 'Identifier' ? (property['name'] as string) : undefined,
    computed: member['computed'] === true,
    offset: typeof member['start'] === 'number' ? member['start'] : 0,
  };
}

function lineOf(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < source.length; index++) {
    if (source[index] === '\n') line++;
  }
  return line;
}

/**
 * Every write to a declared `SessionState` field through a binding named `session`, in any
 * assignment or update form. `session-store.ts` is excluded: it owns the record and may write
 * anything on it.
 *
 * A computed write (`session[key] = …`) cannot be attributed to a field, so it is reported
 * against the sentinel field name `[computed]` — which has no owner and therefore fails,
 * rather than passing unnoticed.
 */
export function findSessionStateWrites(
  sources: ReadonlyMap<string, string>,
  fields: readonly string[],
): SessionStateWrite[] {
  const declared = new Set(fields);
  const writes: SessionStateWrite[] = [];

  for (const [file, source] of sources) {
    if (!file.startsWith('src/daemon/')) continue;
    if (path.posix.basename(file) === 'session-store.ts') continue;

    const parsed = parseSync(file, source);
    const visit = (node: unknown): void => {
      if (node === null || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (const child of node) visit(child);
        return;
      }
      const record = node as Record<string, unknown>;
      const target = writeTarget(record);
      if (target && target.object !== undefined && isSessionBinding(target.object)) {
        if (target.computed) {
          writes.push({ file, line: lineOf(source, target.offset), field: '[computed]' });
        } else if (target.field !== undefined && declared.has(target.field)) {
          writes.push({ file, line: lineOf(source, target.offset), field: target.field });
        }
      }
      for (const key of Object.keys(record)) visit(record[key]);
    };
    visit(parsed.program);
  }

  return writes.sort(
    (left, right) => left.file.localeCompare(right.file) || left.line - right.line,
  );
}
