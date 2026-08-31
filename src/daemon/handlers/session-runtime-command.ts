import type { DaemonRequest, DaemonResponse } from '../types.ts';
import { publicPlatformString } from '@agent-device/kernel/device';
import { clearRuntimeHintsRuntimeUse } from '@agent-device/contracts/application-lifecycle-runtime-plan';
import { SessionStore } from '../session-store.ts';
import { errorResponse } from '../response.ts';
import { expireRefFrame } from '../ref-frame.ts';
import { admitRuntimeUse } from '../runtime-admission.ts';
import {
  buildRuntimeHints,
  countConfiguredRuntimeHints,
  hasRuntimeTransportHints,
  mergeRuntimeHints,
  runtimeHintValues,
  toRuntimePlatform,
} from '../session-runtime.ts';
import type { BindDeviceRuntime, InspectDeviceRuntimeFacts } from '../request-runtime-binding.ts';
import { handlePortReverseCommand } from './session-runtime-port-reverse.ts';
import { contextFromFlags } from '../context.ts';
import { resolveBoundGestureViewportRuntime } from '../gesture-runtime.ts';

type RuntimeAction = 'set' | 'show' | 'clear';
type RuntimeCommandDevice = NonNullable<ReturnType<SessionStore['get']>>['device'];

type RuntimeCommandAdmission = Readonly<{
  device: RuntimeCommandDevice;
  inspectFacts?: InspectDeviceRuntimeFacts;
  bindDevice?: BindDeviceRuntime;
}>;

// `runtime set` and `show` are daemon session policy; this is the sole facts admission and
// implementation binding for the one native effect, clearing applied runtime hints.
async function admitClearRuntime(params: RuntimeCommandAdmission) {
  return await admitRuntimeUse({
    ...params,
    command: 'runtime clear',
    use: clearRuntimeHintsRuntimeUse,
  });
}

export async function handleRuntimeCommand(params: {
  req: DaemonRequest;
  sessionName: string;
  logPath: string;
  sessionStore: SessionStore;
  inspectFacts?: InspectDeviceRuntimeFacts;
  bindDevice?: BindDeviceRuntime;
}): Promise<DaemonResponse> {
  const { req, sessionName, sessionStore } = params;
  const action = (req.positionals?.[0] ?? 'show').toLowerCase();
  if (action === 'port-reverse') {
    return await handlePortReverseCommand({
      req,
      session: sessionStore.get(sessionName),
      inspectFacts: params.inspectFacts,
      bindDevice: params.bindDevice,
    });
  }
  if (action === 'gesture-viewport') {
    return await readGestureViewport({ ...params, session: sessionStore.get(sessionName) });
  }
  if (!isRuntimeAction(action)) {
    return errorResponse(
      'INVALID_ARGS',
      'runtime requires set, show, clear, port-reverse, or gesture-viewport',
    );
  }
  const session = sessionStore.get(sessionName);
  const current = sessionStore.getRuntimeHints(sessionName);
  if (action === 'clear') {
    return await clearRuntimeCommand({
      sessionName,
      sessionStore,
      session,
      current,
      inspectFacts: params.inspectFacts,
      bindDevice: params.bindDevice,
    });
  }
  if (action === 'show') {
    return showRuntimeCommand(sessionName, current);
  }

  return setRuntimeCommand({ req, sessionName, sessionStore, session, current });
}

async function readGestureViewport(params: {
  req: DaemonRequest;
  logPath: string;
  session: ReturnType<SessionStore['get']>;
  inspectFacts?: InspectDeviceRuntimeFacts;
  bindDevice?: BindDeviceRuntime;
}): Promise<DaemonResponse> {
  if (!params.session) {
    return errorResponse('SESSION_NOT_FOUND', 'No active session. Run open first.');
  }
  const runtime = await resolveBoundGestureViewportRuntime({
    device: params.session.device,
    inspectFacts: params.inspectFacts,
    bindDevice: params.bindDevice,
  });
  if (!runtime.ok) return runtime.response;
  const context = contextFromFlags(
    params.logPath,
    params.req.flags,
    params.session.appBundleId,
    params.session.trace?.outPath,
    params.req.meta?.requestId,
    params.req.meta,
  );
  const viewport = await runtime.read(context);
  return { ok: true, data: { viewport } };
}

function isRuntimeAction(action: string): action is RuntimeAction {
  return action === 'set' || action === 'show' || action === 'clear';
}

async function clearRuntimeCommand(params: {
  sessionName: string;
  sessionStore: SessionStore;
  session: ReturnType<SessionStore['get']>;
  current: ReturnType<SessionStore['getRuntimeHints']>;
  inspectFacts?: InspectDeviceRuntimeFacts;
  bindDevice?: BindDeviceRuntime;
}): Promise<DaemonResponse> {
  const { sessionName, sessionStore, session, current, inspectFacts, bindDevice } = params;
  if (hasRuntimeTransportHints(current) && session?.appBundleId) {
    const admission = await admitClearRuntime({
      device: session.device,
      inspectFacts,
      bindDevice,
    });
    if (admission.type === 'response') return admission.response;
    // Native hint removal can change the app's reachable surface. Expire the existing frame at
    // the mutation boundary, after admission and immediately before the bound package effect.
    expireRefFrame(session);
    await admission.runtime.operations.clearRuntimeHints({
      appId: session.appBundleId,
      values: runtimeHintValues(current),
    });
  }
  const cleared = sessionStore.clearRuntimeHints(sessionName);
  return { ok: true, data: { session: sessionName, cleared } };
}

function showRuntimeCommand(
  sessionName: string,
  current: ReturnType<SessionStore['getRuntimeHints']>,
): DaemonResponse {
  return {
    ok: true,
    data: {
      session: sessionName,
      configured: Boolean(current),
      runtime: current,
    },
  };
}

function sessionLeafPlatform(
  session: ReturnType<SessionStore['get']>,
): ReturnType<typeof publicPlatformString> | undefined {
  return session ? publicPlatformString(session.device) : undefined;
}

function setRuntimeCommand(params: {
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
  session: ReturnType<SessionStore['get']>;
  current: ReturnType<SessionStore['getRuntimeHints']>;
}): DaemonResponse {
  const { req, sessionName, sessionStore, session, current } = params;
  // approach (b): resolve the session's PUBLIC leaf platform (ios/macos), never the
  // internal `apple`, so the legacy `--platform ios` selector still matches.
  const sessionLeaf = sessionLeafPlatform(session);
  const platform = toRuntimePlatform(req.flags?.platform ?? current?.platform ?? sessionLeaf);
  if (!platform) {
    return errorResponse(
      'INVALID_ARGS',
      'runtime set only supports iOS and Android sessions. Pass --platform ios|android or open an iOS/Android session first.',
    );
  }
  if (sessionLeaf !== undefined && sessionLeaf !== platform) {
    return errorResponse(
      'INVALID_ARGS',
      `runtime set targets ${platform}, but session "${sessionName}" is already bound to ${sessionLeaf}.`,
    );
  }
  const nextRuntime = mergeRuntimeHints(current, buildRuntimeHints(req.flags, platform));
  if (countConfiguredRuntimeHints(nextRuntime) === 0) {
    return errorResponse(
      'INVALID_ARGS',
      'runtime set requires at least one hint such as --metro-host, --metro-port, --bundle-url, or --launch-url.',
    );
  }
  sessionStore.setRuntimeHints(sessionName, nextRuntime);
  return {
    ok: true,
    data: {
      session: sessionName,
      configured: true,
      runtime: nextRuntime,
    },
  };
}
