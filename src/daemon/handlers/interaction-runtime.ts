import { dispatchCommand } from '../../core/dispatch.ts';
import type {
  AgentDeviceBackend,
  BackendActionResult,
  BackendSnapshotResult,
} from '../../backend.ts';
import { createAgentDevice } from '../../runtime.ts';
import { AppError } from '../../utils/errors.ts';
import type { SessionState } from '../types.ts';
import { setSessionSnapshot } from '../session-snapshot.ts';
import type { InteractionHandlerParams } from './interaction-common.ts';
import type { CaptureSnapshotForSession } from './interaction-snapshot.ts';
import { createDaemonRuntimePolicy } from '../runtime-policy.ts';
import { createDaemonRuntimeSessionStore } from '../runtime-session.ts';

export function createInteractionRuntime(
  params: InteractionHandlerParams & {
    captureSnapshotForSession: CaptureSnapshotForSession;
  },
) {
  const session = params.sessionStore.get(params.sessionName);
  if (!session) throw new AppError('SESSION_NOT_FOUND', 'No active session. Run open first.');
  return createAgentDevice({
    backend: createInteractionBackend({ ...params, session }),
    ...createDaemonRuntimePolicy('interaction commands', { plural: true }),
    sessions: createDaemonRuntimeSessionStore({
      sessionName: params.sessionName,
      getSession: () => session,
      recordOptions: { includeSnapshot: true },
      setRecord: (record) => {
        if (!record.snapshot) return;
        setSessionSnapshot(session, record.snapshot);
        params.sessionStore.set(params.sessionName, session);
      },
    }),
  });
}

function createInteractionBackend(
  params: InteractionHandlerParams & { session: SessionState } & {
    captureSnapshotForSession: CaptureSnapshotForSession;
  },
): AgentDeviceBackend {
  const { req, session } = params;
  return {
    platform: session.device.platform,
    captureSnapshot: async (_context, options): Promise<BackendSnapshotResult> => ({
      snapshot: await params.captureSnapshotForSession(
        session,
        req.flags,
        params.sessionStore,
        params.contextFromFlags,
        {
          interactiveOnly: options?.interactiveOnly === true,
          includeRects: options?.includeRects === true,
        },
      ),
    }),
    tap: async (_context, point): Promise<BackendActionResult> =>
      toBackendActionResult(
        await dispatchCommand(
          session.device,
          'press',
          [String(point.x), String(point.y)],
          req.flags?.out,
          params.contextFromFlags(req.flags, session.appBundleId, session.trace?.outPath),
        ),
      ),
    fill: async (_context, point, text): Promise<BackendActionResult> =>
      toBackendActionResult(
        await dispatchCommand(
          session.device,
          'fill',
          [String(point.x), String(point.y), text],
          req.flags?.out,
          params.contextFromFlags(req.flags, session.appBundleId, session.trace?.outPath),
        ),
      ),
    longPress: async (_context, point, options): Promise<BackendActionResult> =>
      toBackendActionResult(
        await dispatchCommand(
          session.device,
          'longpress',
          [
            String(point.x),
            String(point.y),
            ...(options?.durationMs === undefined ? [] : [String(options.durationMs)]),
          ],
          req.flags?.out,
          params.contextFromFlags(req.flags, session.appBundleId, session.trace?.outPath),
        ),
      ),
    typeText: async (_context, text): Promise<BackendActionResult> =>
      toBackendActionResult(
        await dispatchCommand(
          session.device,
          'type',
          [text],
          req.flags?.out,
          params.contextFromFlags(req.flags, session.appBundleId, session.trace?.outPath),
        ),
      ),
  };
}

function toBackendActionResult(data: unknown): BackendActionResult {
  return data && typeof data === 'object' ? (data as Record<string, unknown>) : undefined;
}
