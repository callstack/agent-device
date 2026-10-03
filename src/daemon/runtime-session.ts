import type { CommandSessionRecord, CommandSessionStore } from '../runtime-contract.ts';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { refFrameTree } from './ref-frame.ts';
import type { SessionRef, SessionState } from './session-state.ts';
import type { SessionStore } from './session-store.ts';

export type RuntimeSessionRecordOptions = {
  includeSnapshot?: boolean;
  /**
   * ADR 0014: omit the authorized frame tree so `@ref` resolution binds against
   * the latest observation instead. Set for a mutating `find`'s internal leaf
   * dispatch, whose ref was just re-resolved by locator against the find's fresh
   * capture — the frame model does not govern that internal re-resolution.
   */
  omitRefFrameSnapshot?: boolean;
  metadata?: Record<string, unknown>;
};

function toRuntimeSessionRecord(
  session: SessionState | undefined,
  name: string,
  options: RuntimeSessionRecordOptions = {},
): CommandSessionRecord | undefined {
  if (!session) return undefined;
  const frameTree = refFrameTree(session);
  return {
    name,
    appBundleId: session.appBundleId,
    appName: session.appName,
    ...(options.includeSnapshot === true
      ? {
          snapshot: session.snapshot,
          // ADR 0014: expose the authorized frame tree so ref resolution binds a
          // `@eN` to the node the caller was authorized against, not to whatever
          // now sits at that index in a newer observation.
          ...(frameTree && options.omitRefFrameSnapshot !== true
            ? { refFrameSnapshot: frameTree }
            : {}),
        }
      : {}),
    metadata: {
      surface: session.surface,
      ...(options.metadata ?? {}),
    },
  };
}

export function createReadonlyRuntimeSessionStore(
  sessionName: string,
  session: SessionState,
): CommandSessionStore {
  return {
    get: (name) =>
      name === sessionName ? toRuntimeSessionRecord(session, sessionName) : undefined,
    set: () => {},
  };
}

export function createDaemonRuntimeSessionStore(params: {
  sessionName: string;
  sessionStore: SessionStore;
  ref: SessionRef | undefined;
  recordOptions?: RuntimeSessionRecordOptions;
  setRecord: (
    record: CommandSessionRecord,
    current: SessionState | undefined,
    ref: SessionRef | undefined,
  ) => SessionRef | void;
}): CommandSessionStore & { getRef(): SessionRef | undefined } {
  let ref = params.ref;
  return {
    getRef: () => (ref ? params.sessionStore.refresh(ref) : undefined),
    get: (name) =>
      name === params.sessionName
        ? toRuntimeSessionRecord(
            ref ? params.sessionStore.resolveCurrent(ref) : undefined,
            params.sessionName,
            params.recordOptions,
          )
        : undefined,
    set: (record) => {
      if (record.name !== params.sessionName) {
        emitDiagnostic({
          level: 'warn',
          phase: 'runtime_session_write_skipped',
          data: { expected: params.sessionName, received: record.name },
        });
        return;
      }
      const current = ref ? params.sessionStore.requireCurrent(ref) : undefined;
      const published = params.setRecord(record, current, ref);
      if (published) ref = published;
    },
  };
}
