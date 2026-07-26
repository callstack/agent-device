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

/**
 * Every `session.<field> = …` (or `+=`/`++`) write to a declared `SessionState` field.
 * `session-store.ts` is excluded: it owns the record and may write anything on it.
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
    const lines = source.split('\n');
    for (let index = 0; index < lines.length; index++) {
      for (const match of lines[index]!.matchAll(
        /\bsession\.([a-zA-Z][A-Za-z0-9]*)\s*(?:=[^=]|\+\+|--|\+=)/g,
      )) {
        const field = match[1]!;
        if (!declared.has(field)) continue;
        writes.push({ file, line: index + 1, field });
      }
    }
  }
  return writes;
}
