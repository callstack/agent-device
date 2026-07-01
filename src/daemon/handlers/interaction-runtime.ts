import { dispatchCommand } from '../../core/dispatch.ts';
import { publicPlatformString } from '../../kernel/device.ts';
import type {
  AgentDeviceBackend,
  BackendActionResult,
  BackendSnapshotResult,
} from '../../backend.ts';
import { createAgentDevice } from '../../runtime.ts';
import { AppError } from '../../kernel/errors.ts';
import type { SessionState } from '../types.ts';
import { setSessionSnapshot } from '../session-snapshot.ts';
import type { InteractionHandlerParams } from './interaction-common.ts';
import type { CaptureSnapshotForSession } from './interaction-snapshot.ts';
import { createDaemonRuntimePolicy } from '../runtime-policy.ts';
import { createDaemonRuntimeSessionStore } from '../runtime-session.ts';
import { resolveWebProvider, type WebProvider } from '../../platforms/web/provider.ts';
import { stripAtPrefix } from './interaction-touch-targets.ts';
import { NO_ACTIVE_SESSION_MESSAGE } from './response.ts';

export function createInteractionRuntime(
  params: InteractionHandlerParams & {
    captureSnapshotForSession: CaptureSnapshotForSession;
  },
) {
  const session = params.sessionStore.get(params.sessionName);
  if (!session) throw new AppError('SESSION_NOT_FOUND', NO_ACTIVE_SESSION_MESSAGE);
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
  const webProvider = resolveNativeWebInteractionProvider(session);
  return {
    platform: publicPlatformString(session.device),
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
    tapTarget: webProvider?.clickRef
      ? async (_context, target): Promise<BackendActionResult> => {
          await webProvider.clickRef?.(target.ref);
          return { ref: stripAtPrefix(target.ref) };
        }
      : undefined,
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
    fillTarget: webProvider?.fillRef
      ? async (_context, target, text, options): Promise<BackendActionResult> => {
          await webProvider.fillRef?.(target.ref, text, options);
          return {
            ref: stripAtPrefix(target.ref),
            text,
            delayMs: options?.delayMs ?? 0,
          };
        }
      : undefined,
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

function resolveNativeWebInteractionProvider(session: SessionState): WebProvider | undefined {
  if (session.device.platform !== 'web') return undefined;
  const provider = resolveWebProvider();
  return provider.clickRef || provider.fillRef ? provider : undefined;
}

function toBackendActionResult(data: unknown): BackendActionResult {
  return data && typeof data === 'object' ? (data as Record<string, unknown>) : undefined;
}
