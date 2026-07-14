import type { CommandSessionRecord, CommandSessionStore } from '../runtime-contract.ts';
import { emitDiagnostic } from '../utils/diagnostics.ts';
import type { SessionState } from './types.ts';

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
          ...(session.refFrameTree && options.omitRefFrameSnapshot !== true
            ? { refFrameSnapshot: session.refFrameTree }
            : {}),
        }
      : {}),
    metadata: {
      surface: session.surface,
      ...(options.metadata ?? {}),
    },
  };
}

export function createDaemonRuntimeSessionStore(params: {
  sessionName: string;
  getSession: () => SessionState | undefined;
  recordOptions?: RuntimeSessionRecordOptions;
  setRecord: (record: CommandSessionRecord) => void;
}): CommandSessionStore {
  return {
    get: (name) =>
      name === params.sessionName
        ? toRuntimeSessionRecord(params.getSession(), params.sessionName, params.recordOptions)
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
      params.setRecord(record);
    },
  };
}
