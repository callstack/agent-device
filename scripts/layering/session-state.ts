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
  androidSnapshotFreshness: ['src/daemon/android-snapshot-freshness.ts'],

  // ADR 0016 active-session publication. `scriptRecordingState` tracks the armed -> published
  // lifecycle; `recordSession` is the broader "record actions" flag and is deliberately set
  // on its own by paths that record without arming a publication.
  scriptRecordingState: [
    'src/daemon/handlers/session-open.ts',
    'src/daemon/handlers/session-script-publication.ts',
  ],
  recordSession: [
    'src/daemon/handlers/session-close.ts',
    'src/daemon/handlers/session-open.ts',
    'src/daemon/handlers/session-replay-runtime.ts',
    'src/daemon/handlers/session-script-publication.ts',
    'src/daemon/session-action-recorder.ts',
  ],
  saveScriptPath: [
    'src/daemon/handlers/session-replay-runtime.ts',
    'src/daemon/handlers/session-script-publication.ts',
    'src/daemon/session-action-recorder.ts',
  ],
  saveScriptForce: [
    'src/daemon/handlers/session-replay-runtime.ts',
    'src/daemon/handlers/session-script-publication.ts',
    'src/daemon/session-action-recorder.ts',
  ],
  saveScriptDefaultedHealedPath: [
    'src/daemon/handlers/session-replay-runtime.ts',
    'src/daemon/session-action-recorder.ts',
  ],
  saveScriptBoundary: ['src/daemon/handlers/session-replay-runtime.ts'],
  saveScriptCommitted: ['src/daemon/session-script-writer.ts'],
  repairSourcePath: ['src/daemon/handlers/session-replay-runtime.ts'],
  pendingRecordAndHeal: ['src/daemon/handlers/session-replay-resume.ts'],
  repairPlatformCloseSucceeded: ['src/daemon/handlers/session-close.ts'],
  repairPlatformCloseIdentity: ['src/daemon/handlers/session-close.ts'],

  trace: ['src/daemon/handlers/record-trace.ts'],
  recording: ['src/daemon/handlers/record-trace-recording.ts'],
  applePerf: ['src/daemon/handlers/session-perf-xctrace.ts', 'src/daemon/session-teardown.ts'],
  nativePerf: ['src/daemon/session-teardown.ts'],
  audioProbe: ['src/daemon/audio-probe.ts'],
  pendingInteractionOutcome: ['src/daemon/interaction-outcome-policy.ts'],
  postGestureStabilization: ['src/daemon/post-gesture-stabilization.ts'],
};

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
      if (target && target.object === 'session') {
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
