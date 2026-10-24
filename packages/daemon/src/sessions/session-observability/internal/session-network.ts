import type { DaemonPlatformServices } from '../../../core/platform-services.ts';
import type {
  NetworkCaptureStartResult,
  NetworkCaptureStopResult,
  NetworkDumpResult,
} from '@agent-device/contracts/network-runtime';
import {
  networkAdmissionUse,
  networkCaptureStartUse,
  networkCaptureStopUse,
  resolveNetworkRuntimePlan,
} from '@agent-device/contracts/network-runtime-plan';
import {
  type DaemonFailureResponse,
  NETWORK_INCLUDE_MODES,
  type NetworkIncludeMode,
  errorResponse,
  type DaemonResponse,
} from '@agent-device/kernel/contracts';
import { AppError, normalizeError } from '@agent-device/kernel/errors';
import type { BindDeviceRuntime } from '../../../core/request-runtime-binding.ts';
import type { SessionStore } from '../../../core/session-store.ts';
import type { DaemonRequest } from '../../../core/daemon-request.ts';

const NETWORK_DUMP_ACTIONS = ['dump', 'log'] as const;
const NETWORK_ACTIONS = [...NETWORK_DUMP_ACTIONS, 'start', 'stop'] as const;
const NETWORK_ACTIONS_MESSAGE = `network requires ${NETWORK_ACTIONS.join(', ')}`;
const NETWORK_INCLUDE_MESSAGE = `network include mode must be one of: ${NETWORK_INCLUDE_MODES.join(', ')}`;
const NETWORK_MAX_PAYLOAD_CHARS = 2048;
const NETWORK_MAX_SCAN_LINES = 4000;

export type NetworkHandlerParams = Readonly<{
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
  bindDevice?: BindDeviceRuntime;
  platformServices: DaemonPlatformServices;
}>;

type NetworkSession = NonNullable<ReturnType<SessionStore['get']>>;

type NetworkRequest = Readonly<{
  action: (typeof NETWORK_ACTIONS)[number];
  include: NetworkIncludeMode;
  maxEntries: number;
  hosts: readonly string[] | undefined;
}>;

export async function handleNetworkCommand(params: NetworkHandlerParams): Promise<DaemonResponse> {
  const session = params.sessionStore.get(params.sessionName);
  if (!session) {
    return errorResponse('SESSION_NOT_FOUND', 'network requires an active session');
  }

  try {
    const bindDevice = requireNetworkBindDevice(params.bindDevice);
    // The dump path keeps its fail-closed admission before any argument parsing; only an exact
    // start/stop positional routes to capture control, and every other word stays the dump's
    // admission-then-validation order.
    const rawAction = (params.req.positionals?.[0] ?? 'dump').toLowerCase();
    if (rawAction === 'start' || rawAction === 'stop') {
      const request = resolveNetworkRequest(params.req);
      if (!request.ok) return request;
      return await handleNetworkCaptureControl(bindDevice, session, params.sessionName, {
        ...request,
        action: rawAction,
      });
    }
    const admission = await bindDevice(session.device, networkAdmissionUse);
    const networkFact = admission.facts.networkDump;
    if (!networkFact.available) return unsupportedNetworkResponse(networkFact.hint);
    const request = resolveNetworkRequest(params.req);
    if (!request.ok) return request;
    const dumpAction = request.action;
    if (dumpAction !== 'dump' && dumpAction !== 'log') {
      return errorResponse('INVALID_ARGS', NETWORK_ACTIONS_MESSAGE);
    }
    return await handleNetworkDump(bindDevice, session, params.sessionName, {
      ...request,
      action: dumpAction,
    });
  } catch (error) {
    return { ok: false, error: normalizeError(error) };
  }
}

async function handleNetworkDump(
  bindDevice: BindDeviceRuntime,
  session: NetworkSession,
  sessionId: string,
  request: NetworkRequest & Readonly<{ action: 'dump' | 'log' }>,
): Promise<DaemonResponse> {
  const plan = resolveNetworkRuntimePlan({
    action: request.action,
    include: request.include,
  });
  const runtime = await bindDevice(session.device, plan.use);
  const appLog = session.appLog?.handle.inspect();
  const result = await runtime.operations.networkDump({
    sessionId,
    appBundleId: session.appBundleId,
    ...(appLog ? { appLogSnapshot: { state: appLog.state, startedAt: appLog.startedAt } } : {}),
    maxEntries: request.maxEntries,
    include: plan.include,
    maxPayloadChars: NETWORK_MAX_PAYLOAD_CHARS,
    maxScanLines: NETWORK_MAX_SCAN_LINES,
  });
  return networkDumpResponse(result, request, Boolean(session.appLog), appLog?.state);
}

/**
 * `network start` / `network stop`: arms or disarms the session's live capture source. The dump
 * never installs a source (ADR 0037), so this is the only arming path; a device whose runtime
 * owner has no capture source answers with a typed refusal instead of silently doing nothing.
 */
async function handleNetworkCaptureControl(
  bindDevice: BindDeviceRuntime,
  session: NetworkSession,
  sessionId: string,
  request: NetworkRequest & Readonly<{ action: 'start' | 'stop' }>,
): Promise<DaemonResponse> {
  if (request.action === 'start') {
    const admission = await bindDevice(session.device, networkCaptureStartUse);
    const fact = admission.facts.networkCaptureStart;
    if (!fact.available) return captureUnsupportedResponse('start', fact.reason, fact.hint);
    const runtime = await bindDevice(session.device, networkCaptureStartUse);
    const result = await runtime.operations.networkCaptureStart({
      sessionId,
      ...(session.appBundleId ? { appBundleId: session.appBundleId } : {}),
      ...(request.hosts ? { hosts: request.hosts } : {}),
    });
    return networkCaptureStartResponse(result);
  }
  const admission = await bindDevice(session.device, networkCaptureStopUse);
  const fact = admission.facts.networkCaptureStop;
  if (!fact.available) return captureUnsupportedResponse('stop', fact.reason, fact.hint);
  const runtime = await bindDevice(session.device, networkCaptureStopUse);
  const result = await runtime.operations.networkCaptureStop({ sessionId });
  return networkCaptureStopResponse(result);
}

function requireNetworkBindDevice(bindDevice: BindDeviceRuntime | undefined): BindDeviceRuntime {
  if (bindDevice) return bindDevice;
  throw new AppError('COMMAND_FAILED', 'Device runtime gateway is not configured', {
    reason: 'runtime-gateway-missing',
  });
}

function resolveNetworkRequest(
  req: DaemonRequest,
): (NetworkRequest & Readonly<{ ok: true }>) | DaemonFailureResponse {
  const action = resolveNetworkAction(req);
  if (!action.ok) return action;
  const maxEntries = resolveNetworkLimit(req);
  if (!maxEntries.ok) return maxEntries;
  const include = resolveNetworkIncludeMode(req);
  if (!include.ok) return include;
  const hosts = resolveNetworkHosts(req);
  if (!hosts.ok) return hosts;
  return {
    ok: true,
    action: action.action,
    include: include.include,
    maxEntries: maxEntries.maxEntries,
    hosts: hosts.hosts,
  };
}

function resolveNetworkAction(
  req: DaemonRequest,
): { ok: true; action: (typeof NETWORK_ACTIONS)[number] } | DaemonFailureResponse {
  const action = (req.positionals?.[0] ?? 'dump').toLowerCase();
  if (!NETWORK_ACTIONS.includes(action as (typeof NETWORK_ACTIONS)[number])) {
    return errorResponse('INVALID_ARGS', NETWORK_ACTIONS_MESSAGE);
  }
  return { ok: true, action: action as (typeof NETWORK_ACTIONS)[number] };
}

function resolveNetworkHosts(
  req: DaemonRequest,
): { ok: true; hosts: readonly string[] | undefined } | DaemonFailureResponse {
  const hosts = req.flags?.networkHosts;
  if (hosts === undefined) return { ok: true, hosts: undefined };
  if (hosts.length === 0 || hosts.some((host) => host.trim().length === 0)) {
    return errorResponse('INVALID_ARGS', 'network --hosts requires at least one domain selector');
  }
  return { ok: true, hosts: hosts.map((host) => host.trim()) };
}

function resolveNetworkLimit(
  req: DaemonRequest,
): { ok: true; maxEntries: number } | DaemonFailureResponse {
  const maxEntries = req.positionals?.[1] ? Number.parseInt(req.positionals[1], 10) : 25;
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 200) {
    return errorResponse('INVALID_ARGS', 'network dump limit must be an integer in range 1..200');
  }
  return { ok: true, maxEntries };
}

function resolveNetworkIncludeMode(
  req: DaemonRequest,
): { ok: true; include: NetworkIncludeMode } | DaemonFailureResponse {
  const positionalInclude = req.positionals?.[2]?.toLowerCase();
  const flagInclude = req.flags?.networkInclude;
  if (positionalInclude && flagInclude && positionalInclude !== flagInclude) {
    return errorResponse(
      'INVALID_ARGS',
      'network include mode was provided both positionally and via --include with different values',
    );
  }
  const requestedInclude = (flagInclude ?? positionalInclude ?? 'summary').toLowerCase();
  if (!NETWORK_INCLUDE_MODES.includes(requestedInclude as NetworkIncludeMode)) {
    return errorResponse('INVALID_ARGS', NETWORK_INCLUDE_MESSAGE);
  }
  return { ok: true, include: requestedInclude as NetworkIncludeMode };
}

function unsupportedNetworkResponse(hint: string | undefined): DaemonFailureResponse {
  return {
    ok: false,
    error: {
      code: 'UNSUPPORTED_OPERATION',
      message: 'network is not supported on this device',
      hint,
    },
  };
}

function captureUnsupportedResponse(
  action: 'start' | 'stop',
  reason: string,
  hint: string | undefined,
): DaemonFailureResponse {
  return {
    ok: false,
    error: {
      code: 'UNSUPPORTED_OPERATION',
      message: `network ${action} is not supported on this device's runtime owner`,
      hint,
      details: { reason },
    },
  };
}

function networkCaptureStartResponse(result: NetworkCaptureStartResult): DaemonResponse {
  if (!result.started) {
    return {
      ok: false,
      error: {
        code: 'COMMAND_FAILED',
        message: result.message,
        details: { reason: result.reason },
      },
    };
  }
  return {
    ok: true,
    data: {
      started: true,
      source: result.source,
      hosts: result.hosts,
      requiresRelaunch: result.requiresRelaunch,
      capturingBodies: result.capturingBodies,
    },
  };
}

function networkCaptureStopResponse(result: NetworkCaptureStopResult): DaemonResponse {
  return { ok: true, data: { stopped: result.stopped } };
}

function networkDumpResponse(
  result: NetworkDumpResult,
  request: Pick<NetworkRequest, 'include' | 'maxEntries'>,
  active: boolean,
  state: 'active' | 'recovering' | 'ended' | 'failed' | undefined,
): DaemonResponse {
  if (result.source === 'app-log') {
    return {
      ok: true,
      data: {
        ...result.dump,
        source: result.source,
        active,
        state: state ?? 'inactive',
        backend: result.backend,
        notes: result.notes,
      },
    };
  }

  return {
    ok: true,
    data: {
      entries: result.entries,
      source: result.source,
      active: true,
      state: 'active',
      backend: result.backend,
      include: request.include,
      matchedLines: result.entries.length,
      scannedLines: result.entries.length,
      limits: {
        maxEntries: request.maxEntries,
        maxPayloadChars: result.limits?.maxPayloadChars ?? NETWORK_MAX_PAYLOAD_CHARS,
        maxScanLines: result.entries.length,
      },
      notes: result.notes,
    },
  };
}
